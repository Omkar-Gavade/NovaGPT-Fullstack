import { randomUUID } from "node:crypto";
import { enrichContext } from "../../infrastructure/telemetry/traceContext.js";
import { nullTracer } from "../../infrastructure/telemetry/Tracer.js";
import { Thread, Message, Role, FinishReason } from "../../domain/conversation/Thread.js";
import {
  buildContent,
  requirementsOfContent,
  withoutPayloads,
} from "../../domain/conversation/MessageContent.js";
import {
  parseModelJson,
  validateAgainstSchema,
  unsupportedKeywords,
} from "../../domain/capability/SchemaValidator.js";
import { ContextEngine } from "../../domain/context/ContextEngine.js";
import { CalibratedTokenEstimator } from "../../domain/context/TokenEstimator.js";
import { StreamEventType } from "../../domain/streaming/StreamEvent.js";
import { AppError, ErrorKind, CancelledError } from "../../domain/errors/index.js";

/**
 * The chat orchestrator.
 *
 * The one place that knows the order of operations for answering a message:
 * load the thread, assemble context, route, execute, persist, calibrate. Every
 * entry point — send, stream, regenerate, continue — is a thin variation on
 * that sequence, which is why they share one class instead of four that drift.
 *
 * It **owns no policy**. Ranking belongs to `RoutingPolicy`, trimming to
 * `ContextEngine`, retry to `RetryPolicy`, wire formats to adapters. This class
 * is orchestration: sequencing, failure semantics, and what gets written down
 * (docs/backend/02-architecture.md#why-the-application-layer-exists-at-all).
 *
 * Application layer, so no HTTP and no Mongo: it takes commands and ports.
 */
export class ChatOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.threads          ThreadRepositoryPort
   * @param {import("../routing/RoutingService.js").RoutingService} deps.routingService
   * @param {import("../routing/RoutingExecutor.js").RoutingExecutor} deps.routingExecutor
   * @param {import("../streaming/StreamingExecutor.js").StreamingExecutor} deps.streamingExecutor
   * @param {import("./StreamRegistry.js").StreamRegistry} deps.streamRegistry
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   */
  constructor({
    threads,
    routingService,
    routingExecutor,
    streamingExecutor,
    streamRegistry,
    clock,
    logger,
    metrics,
    tracer = nullTracer,
    logContent = false,
    userKeys = null,
    attachments = null,
  }) {
    this.tracer = tracer;
    // Off unless an operator turned it on, and that decision is audited at
    // boot. Held as a field rather than read from config at each call site, so
    // there is exactly one place that decides
    // (docs/backend/11-observability.md#what-is-never-logged).
    this.logContent = logContent === true;
    // BYOK. Null when the deployment has no encryption key configured, in which
    // case every request runs on the platform credential.
    this.userKeys = userKeys;
    // Null when attachments are not enabled. Ingestion validates before any
    // byte reaches a message, so this must run *before* content is built.
    this.attachments = attachments;
    this.threads = threads;
    this.routingService = routingService;
    this.routingExecutor = routingExecutor;
    this.streamingExecutor = streamingExecutor;
    this.streamRegistry = streamRegistry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "chat" }) ?? logger;
    this.metrics = metrics;
  }

  /* ====================================================================== *
   * Entry points
   * ====================================================================== */

  /**
   * Answer a message, without streaming.
   *
   * @param {object} command
   * @returns {Promise<{thread, userMessage, assistantMessage, decision, switched}>}
   */
  async send(command) {
    const prepared = await this.#prepare(command);
    const { thread, decision, contextMessages, report, settings } = prepared;

    const outcome = await this.routingExecutor.execute({
      decision,
      switchPolicy: settings.switchPolicy,
      signal: command.signal,
      options: generationOptions(settings, command.responseFormat),
      // The credential is resolved *inside* the closure, because which provider
      // answers is not known until the executor picks one — and it may pick a
      // different one on the next attempt.
      invoke: (provider, model, options) =>
        provider.generate(contextMessages, withCredential(options, prepared.credentials, provider)),
      userKeyProviders: new Set(prepared.credentials.keys()),
    });

    // **Checked before the client sees it.** A provider that advertises schema
    // enforcement does not always deliver it, and a caller who asked for
    // `json_schema` cannot tell a provider's lapse from a bug of their own.
    const structured = this.#validateStructured(command.responseFormat, outcome.result.text);

    const assistant = this.#assistantMessage({
      content: outcome.result.text,
      model: outcome.model,
      usage: outcome.result.usage,
      finishReason: outcome.result.finishReason ?? FinishReason.STOP,
      report,
      decision,
      structured,
    });

    const saved = await this.#persist(prepared, assistant, outcome.result.usage, report);

    return {
      thread: saved,
      userMessage: prepared.userMessage,
      assistantMessage: assistant,
      decision,
      switched: outcome.switched,
      report,
    };
  }

  /**
   * Answer a message as a stream.
   *
   * Returns the stream id *before* the generator so the caller can send it to
   * the client immediately — a client that cannot learn the id until the stream
   * ends has no way to stop it, which defeats the endpoint.
   *
   * Persistence happens when the stream completes. A cancelled or failed stream
   * writes nothing: a half-written assistant turn corrupts the thread and then
   * becomes context for every later turn
   * (docs/backend/07-streaming-engine.md#cancellation).
   */
  async beginStream(command) {
    const prepared = await this.#prepare(command);
    const { thread, decision, contextMessages, report, settings } = prepared;

    const streamId = randomUUID();
    const controller = this.streamRegistry.register(streamId, {
      threadId: thread.id,
      ownerId: command.ownerId ?? null,
      signal: command.signal,
    });

    const self = this;

    async function* run() {
      let content = "";
      let usage = null;
      let finishReason = FinishReason.STOP;
      let switched = null;
      let finalModel = decision.primary;

      try {
        const events = self.streamingExecutor.stream({
          decision,
          switchPolicy: settings.switchPolicy,
          signal: controller.signal,
          options: generationOptions(settings, command.responseFormat),
          invoke: (provider, model, options) =>
            provider.stream(contextMessages, withCredential(options, prepared.credentials, provider)),
          userKeyProviders: new Set(prepared.credentials.keys()),
        });

        for await (const event of events) {
          switch (event.type) {
            case StreamEventType.DELTA:
              content += event.text;
              break;
            case StreamEventType.SWITCHED:
              // The buffer resets with the attempt: two models do not continue
              // each other's sentences.
              content = "";
              switched = event;
              finalModel = { id: event.to.model, provider: event.to.provider };
              break;
            case StreamEventType.USAGE:
              usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
              break;
            case StreamEventType.DONE:
              finishReason = event.finishReason ?? FinishReason.STOP;
              break;
            default:
              break;
          }
          yield event;
        }

        // Only a completed stream is written down.
        if (content) {
          const assistant = self.#assistantMessage({
            content,
            model: finalModel,
            usage,
            finishReason,
            report,
            decision,
          });
          await self.#persist(prepared, assistant, usage, report);
        }
      } catch (error) {
        if (CancelledError.is(error)) {
          self.logger?.info("chat.stream_cancelled", {
            threadId: thread.id,
            streamId,
            charsDiscarded: content.length,
          });
          // Deliberately silent to the client: it asked for this, and the
          // connection is usually already gone.
          return;
        }
        throw error;
      } finally {
        self.streamRegistry.release(streamId);
      }
    }

    return { streamId, thread, decision, report, events: run() };
  }

  /**
   * Regenerate an assistant turn.
   *
   * Works by rewinding: the thread is truncated to the state *before* the
   * message, so the model does not see its own previous answer as context. A
   * regeneration that includes the prior attempt is not independent, and tends
   * to produce a paraphrase of it.
   */
  async regenerate(command) {
    const thread = await this.#load(command.threadId, command.ownerId);
    const target = thread.findMessage(command.messageId);

    if (!target) {
      throw new AppError("That message is not part of this conversation.", ErrorKind.NOT_FOUND);
    }
    if (!target.isAssistant) {
      throw new AppError("Only an assistant message can be regenerated.", ErrorKind.VALIDATION, {
        field: "messageId",
      });
    }

    // Rewind to just before the assistant turn, then find the user turn it was
    // answering.
    const rewound = thread.truncateFrom(target.id);
    const lastUser = rewound.lastMessage;
    if (!lastUser?.isUser) {
      throw new AppError(
        "There is no user message to regenerate a reply to.",
        ErrorKind.VALIDATION
      );
    }

    // The base excludes the user turn as well, because `#prepare` re-appends it
    // when it persists. Truncating once here — rather than again downstream —
    // is the whole fix for a bug where the second truncation searched a thread
    // the message had already been removed from.
    const base = rewound.truncateFrom(lastUser.id);

    // Persisted before generating, so a crash mid-regeneration leaves a
    // coherent thread rather than one carrying two assistant turns.
    await this.threads.save(base);

    const command2 = {
      threadId: base.id,
      ownerId: command.ownerId,
      settings: command.settings,
      signal: command.signal,
      streaming: command.streaming,
      thread: base,
      userMessage: lastUser,
    };
    return command.streaming ? this.beginStream(command2) : this.send(command2);
  }

  /**
   * Continue a reply that stopped because it hit the output limit.
   *
   * The continuation is appended to the **existing** assistant message rather
   * than added as a second one: two consecutive assistant turns are malformed
   * dialogue, and models trained on well-formed conversation handle them badly.
   */
  async continue_(command) {
    const thread = await this.#load(command.threadId, command.ownerId);
    const target = command.messageId
      ? thread.findMessage(command.messageId)
      : thread.lastAssistantMessage;

    if (!target?.isAssistant) {
      throw new AppError("There is no assistant message to continue.", ErrorKind.NOT_FOUND);
    }
    if (!target.isContinuable) {
      throw new AppError(
        "That reply finished on its own; there is nothing to continue.",
        ErrorKind.VALIDATION,
        { details: { finishReason: target.finishReason } }
      );
    }

    const settings = thread.settings.merge(command.settings ?? {});
    const history = thread.historyBefore(target.id);

    const { decision } = this.routingService.route({
      model: settings.model ?? target.model,
      streaming: Boolean(command.streaming),
      estimatedPromptTokens: thread.totalTokens,
      maxTokens: settings.maxTokens,
    });

    const { messages, report } = this.#context(decision).assemble({
      model: decision.primary,
      history,
      // The truncated reply becomes the last turn, with an explicit
      // instruction. The alternative — resending the user's question — makes
      // the model restart rather than continue.
      newest: {
        role: Role.ASSISTANT,
        content: target.content,
        tokenEstimate: target.tokenEstimate,
      },
      systemPrompt: `${settings.systemPrompt}\n\nContinue the previous reply from exactly where it stopped. Do not repeat what was already said.`.trim(),
      maxTokens: settings.maxTokens,
    });

    const outcome = await this.routingExecutor.execute({
      decision,
      switchPolicy: settings.switchPolicy,
      signal: command.signal,
      options: generationOptions(settings),
      invoke: (provider, model, options) => provider.generate(messages, options),
    });

    const merged = thread.replaceMessage(target.id, {
      content: `${target.text}${outcome.result.text}`,
      finishReason: outcome.result.finishReason ?? FinishReason.STOP,
      tokenEstimate: null,
    });

    const saved = await this.threads.save(merged);
    return { thread: saved, assistantMessage: saved.findMessage(target.id), decision, report };
  }

  /** Stop an in-flight stream. */
  stop(streamId, ownerId = null) {
    const stopped = this.streamRegistry.stop(streamId, ownerId);
    this.logger?.info("chat.stop_requested", { streamId, stopped });
    return stopped;
  }

  /* ====================================================================== *
   * Shared sequence
   * ====================================================================== */

  /**
   * Everything that happens before a provider is called.
   *
   * Shared by send and stream so the two cannot diverge in what context they
   * build or how they route — a divergence there would make streamed and
   * non-streamed answers to the same question differ for reasons nobody could
   * explain.
   */
  async #prepare(command) {
    const thread =
      command.thread ??
      (await this.tracer.span("thread.load", () => this.#loadOrCreate(command)));
    // Every log line, span and usage record from here on carries the thread id.
    // Set once, in the one place every entry point passes through, rather than
    // added to four call sites and forgotten in the fifth.
    enrichContext({ threadId: thread.id });
    const settings = thread.settings.merge(command.settings ?? {});

    // Ingested first: sniffed, size-capped and — for URLs — fetched through the
    // SSRF policy. Nothing downstream ever sees an unvalidated attachment
    // (docs/backend/10-security.md#input-validation).
    const ingested = command.attachments?.length
      ? await this.tracer.span("attachments.ingest", () =>
          this.attachments.ingest(command.attachments, { signal: command.signal })
        )
      : [];

    const userMessage =
      command.userMessage ??
      new Message({
        id: randomUUID(),
        role: Role.USER,
        // Multimodal content, in the canonical shape every adapter maps from.
        // Plain text when there are no attachments, so the common path is
        // unchanged.
        content: buildContent(command.message, ingested),
        attachments: ingested.map((a) => ({ kind: a.kind, mime: a.mime, bytes: a.bytes })),
      });

    const history = thread.messages;
    const engine = this.#context(thread);

    // Route first: the context budget depends on which model answers, so
    // assembling before routing would budget against the wrong window.
    const { decision } = await this.tracer.span("routing.decide", (span) => {
      const decided = this.routingService.route({
        model: settings.model,
        streaming: Boolean(command.streaming),
        // Derived from the **content**, not from what the client labelled its
        // own attachments. A request cannot reach a text-only model by
        // mislabelling its own images.
        ...requirementsOfContent(userMessage.content),
        attachments: userMessage.attachments,
        tools: command.tools,
        responseFormat: command.responseFormat,
        maxTokens: settings.maxTokens,
        estimatedPromptTokens: thread.totalTokens,
      });
      span?.setAttributes({
        "routing.model": decided.decision.primary.id,
        "routing.provider": decided.decision.primary.provider,
        "routing.candidates": decided.decision.consideredCount,
        "routing.pinned": Boolean(settings.model),
      });
      return decided;
    });

    const { messages, report } = await this.tracer.span("context.assemble", (span) => {
      const assembled = engine.assemble({
        model: decision.primary,
        history,
        newest: { role: userMessage.role, content: userMessage.content },
        systemPrompt: settings.systemPrompt,
        maxTokens: settings.maxTokens,
      });
      span?.setAttributes({
        "context.messages": assembled.report.included?.length ?? assembled.messages.length,
        "context.estimated_tokens": assembled.report.estimatedTokens,
        "context.trimmed": assembled.report.trimmed.length,
        "context.compressed": assembled.report.compressed.length,
        "context.budget": assembled.report.promptBudget,
      });
      return assembled;
    });

    this.logger?.info("chat.prepared", {
      threadId: thread.id,
      model: decision.primary.id,
      historyMessages: history.length,
      promptTokens: report.estimatedTokens,
      trimmed: report.trimmed.length,
      compressed: report.compressed.length,
    });

    // Counts, never text — unless content logging is explicitly on. `debug`
    // even then, because production runs at `info` and would otherwise start
    // shipping prompts the moment someone lowered the level for an unrelated
    // reason.
    if (this.logContent) {
      this.logger?.debug("chat.prompt_content", {
        threadId: thread.id,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
    }

    this.metrics.observe("nova_context_tokens", report.estimatedTokens);
    if (report.trimmed.length) this.metrics.increment("nova_context_trimmed_total");
    if (report.compressed.length) this.metrics.increment("nova_context_compressions_total");

    // Resolved once per request rather than per attempt: a failover would
    // otherwise decrypt again, and each decryption is a use of the master key.
    const credentials = (await this.userKeys?.resolve(command.ownerId)) ?? new Map();

    return {
      thread,
      settings,
      userMessage,
      decision,
      contextMessages: messages,
      report,
      engine,
      credentials,
    };
  }

  /**
   * Write the turn pair and feed the estimator.
   *
   * Calibration is the reason usage is threaded this far: the provider's real
   * `promptTokens` is the only ground truth for how wrong the heuristic was,
   * and the corrected factor is stored on the thread so it survives a restart
   * (docs/backend/06-context-engine.md#self-calibration).
   */
  async #persist(prepared, assistantMessage, usage, report) {
    const { thread, userMessage, engine } = prepared;

    // **Binary payloads are stripped before the thread is written.**
    //
    // Storing base64 images would push a conversation past the BSON document
    // limit within a handful of turns, and — worse — the context engine would
    // re-send those bytes to the provider on *every* subsequent message,
    // re-uploading the same image indefinitely. The shape is kept so the UI can
    // still show that an image was sent (docs/backend/08-storage.md).
    const storedUserMessage = userMessage.with({
      content: withoutPayloads(userMessage.content),
    });

    let next = thread
      .appendUserMessage(storedUserMessage)
      .appendAssistantMessage(assistantMessage);

    if (usage?.promptTokens && report.estimatedTokens > 0) {
      const factor = engine.calibrate(report.estimatedTokens, usage.promptTokens);
      next = next.withCorrectionFactor(factor);
      this.metrics.observe(
        "nova_token_estimate_error_ratio",
        report.estimatedTokens / usage.promptTokens
      );
    }

    return this.tracer.span("thread.persist", (span) => {
      span?.setAttributes({ "thread.messages": next.messageCount });
      return this.threads.save(next);
    });
  }

  /**
   * Validate structured output, or explain why it cannot be trusted.
   *
   * Returns the parsed value on success so the client is handed data rather
   * than a string it has to parse again — and throws on a mismatch, because
   * returning malformed output *labelled* as schema-conforming is worse than
   * an error: the client has no reason to check.
   */
  #validateStructured(responseFormat, text) {
    if (responseFormat?.type !== "json_schema") return null;

    const unsupported = unsupportedKeywords(responseFormat.schema);
    if (unsupported.length) {
      // Not fatal. The request works; the guarantee is simply weaker than the
      // schema implies, and the caller should know which part is unchecked.
      this.logger?.warn("chat.schema_partially_enforced", { keywords: unsupported });
    }

    const parsed = parseModelJson(text);
    if (!parsed.ok) {
      throw new AppError(`Structured output failed: ${parsed.error}.`, ErrorKind.PROVIDER_ERROR, {
        expected: true,
        details: { reason: parsed.error },
      });
    }

    const { valid, errors } = validateAgainstSchema(parsed.value, responseFormat.schema);
    if (!valid && responseFormat.strict !== false) {
      this.metrics?.increment("nova_structured_output_total", { outcome: "invalid" });
      throw new AppError(
        "The model's output did not match the requested schema.",
        ErrorKind.PROVIDER_ERROR,
        { expected: true, details: { errors: errors.slice(0, 10), unsupported } }
      );
    }

    this.metrics?.increment("nova_structured_output_total", {
      outcome: valid ? "valid" : "invalid_allowed",
    });
    return { value: parsed.value, valid, errors, unsupported };
  }

  #assistantMessage({ content, model, usage, finishReason, report, decision, structured = null }) {
    return new Message({
      id: randomUUID(),
      role: Role.ASSISTANT,
      content,
      model: model?.id ?? null,
      provider: model?.provider ?? null,
      usage,
      finishReason,
      // The parsed value, so a client is handed data rather than a string it
      // must parse a second time.
      structured: structured?.value ?? undefined,
      // Summaries only — the full objects are in the logs, keyed by trace id.
      contextReport: {
        estimatedTokens: report.estimatedTokens,
        promptBudget: report.budget.promptBudget,
        trimmed: report.trimmed.length,
        compressed: report.compressed.length,
        truncated: report.truncated.length,
      },
      routingDecision: {
        mode: decision.mode,
        reason: decision.reason,
        consideredCount: decision.consideredCount,
      },
    });
  }

  /**
   * A context engine seeded with this conversation's calibration.
   *
   * Built per request rather than shared: the correction factor is
   * per-conversation, and one engine shared across threads would average a
   * Japanese conversation with a Python one and be wrong for both.
   */
  #context(threadOrDecision) {
    const factor = threadOrDecision?.tokenCorrectionFactor ?? 1;
    return new ContextEngine({
      estimator: CalibratedTokenEstimator.fromFactor(factor),
    });
  }

  async #load(threadId, ownerId) {
    const thread = await this.threads.findById(threadId, ownerId);
    if (!thread) throw new AppError("Conversation not found.", ErrorKind.NOT_FOUND);
    return thread;
  }

  /**
   * Load, or create on first message.
   *
   * Upsert-on-send rather than a separate create call: it makes the client's
   * happy path one request, and a retried send cannot create two threads
   * because the id comes from the client.
   */
  async #loadOrCreate({ threadId, ownerId }) {
    const existing = threadId ? await this.threads.findById(threadId, ownerId) : null;
    if (existing) return existing;

    // The id is client-supplied, so "not found for this owner" has two causes:
    // a genuinely new conversation, and someone else's conversation. Creating
    // in the second case would take over that thread on the next save.
    // 404 rather than 403: a 403 confirms the id exists, which is precisely the
    // enumeration a 404 denies (docs/backend/10-security.md#authorization).
    if (threadId && (await this.threads.existsById(threadId))) {
      throw new AppError("Conversation not found.", ErrorKind.NOT_FOUND);
    }

    // Deliberately *not* seeded from the request's settings. Those are a
    // one-off override for this turn; persisting them would make a single
    // "try it hotter" silently change the conversation forever. Thread
    // settings change only through the settings endpoint.
    return new Thread({ id: threadId ?? randomUUID(), userId: ownerId ?? null });
  }
}

/**
 * Attach the user's own key for this provider, when they have one.
 *
 * Per attempt rather than per request, because a failover moves to a different
 * provider — and the key that belongs to one provider must never travel to
 * another (docs/backend/10-security.md#rules-for-user-supplied-keys).
 */
function withCredential(options, credentials, provider) {
  const credential = credentials?.get(provider.id);
  return credential ? { ...options, credential } : options;
}

/** The closed option set adapters receive. Nothing provider-specific crosses. */
function generationOptions(settings, responseFormat = null) {
  const options = {
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    topP: settings.topP,
  };

  // **The schema has to reach the model, not only the validator.**
  //
  // Routing used the response format to pick a `structuredOutput`-capable
  // model, and the orchestrator validated the reply against it — but nothing
  // ever *told the model* to produce JSON. Found during deployment
  // verification: a schema-enforced request to a real Gemini model came back as
  // prose and was correctly rejected by the validator, having asked for prose.
  //
  // Adapters already understand both forms; only the plumbing was missing.
  if (responseFormat?.type === "json_schema" && responseFormat.schema) {
    options.jsonSchema = { name: "response", schema: responseFormat.schema, strict: true };
  } else if (responseFormat?.type === "json") {
    options.json = true;
  }

  return options;
}
