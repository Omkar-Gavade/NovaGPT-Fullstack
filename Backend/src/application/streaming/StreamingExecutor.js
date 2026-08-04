import { StreamSession } from "../../domain/streaming/StreamSession.js";
import { nullTracer } from "../../infrastructure/telemetry/Tracer.js";
import {
  StreamEventType,
  startEvent,
  doneEvent,
  errorEvent,
} from "../../domain/streaming/StreamEvent.js";
import { RetryDecision, SwitchPolicy } from "../../domain/routing/RetryPolicy.js";
import { AppError, ErrorKind, CancelledError, ProviderError, FailureKind } from "../../domain/errors/index.js";

/**
 * Executes a routing decision as a stream.
 *
 * The streaming twin of `RoutingExecutor`, and separate from it on purpose:
 * streaming changes the failure model. In a request/response world a failure is
 * atomic — the client saw nothing until it was decided. In a streaming world a
 * failure can arrive **after the client has rendered 400 tokens**, and retry,
 * failover and persistence all have to answer a question that does not exist
 * otherwise: *what about the output already delivered?*
 *
 * Three rules follow, and they are the whole design
 * (docs/backend/07-streaming-engine.md#failover-mid-stream):
 *
 *   1. **The buffer resets per attempt.** Concatenating attempt 1's partial
 *      output with attempt 2's full output produces "The capital of The capital
 *      of France is Paris." Two models do not continue each other's sentences.
 *   2. **`switched` is emitted before the new attempt's tokens**, so the client
 *      clears its partial render before new content arrives.
 *   3. **A stream that has emitted content is never retried in place.** The
 *      client has those tokens; replaying duplicates them.
 *
 * Provider-agnostic: it consumes `StreamEvent`s and never sees a wire format.
 */
export class StreamingExecutor {
  /**
   * @param {object} deps
   * @param {import("../../domain/routing/RetryPolicy.js").RetryPolicy} deps.retryPolicy
   * @param {import("../../infrastructure/providers/registry/ProviderRegistry.js").ProviderRegistry} deps.registry
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   * @param {number} [deps.firstTokenTimeoutMs] a stream that never starts
   * @param {number} [deps.interTokenTimeoutMs] a stream that stalls mid-flight
   * @param {number} [deps.overallTimeoutMs]
   */
  constructor({
    retryPolicy,
    registry,
    clock,
    logger,
    metrics,
    firstTokenTimeoutMs = 20_000,
    usageRecorder,
    tracer = nullTracer,
    interTokenTimeoutMs = 30_000,
    overallTimeoutMs = 120_000,
  }) {
    this.retryPolicy = retryPolicy;
    this.registry = registry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "streaming" }) ?? logger;
    this.metrics = metrics;
    this.firstTokenTimeoutMs = firstTokenTimeoutMs;
    this.usageRecorder = usageRecorder;
    this.tracer = tracer;
    this.interTokenTimeoutMs = interTokenTimeoutMs;
    this.overallTimeoutMs = overallTimeoutMs;
  }

  /**
   * Stream a routing decision, yielding normalised events.
   *
   * @param {object} input
   * @param {import("../../domain/routing/RoutingDecision.js").RoutingDecision} input.decision
   * @param {(provider, model, options) => AsyncIterable<object>} input.invoke
   * @param {object} [input.options]
   * @param {string} [input.switchPolicy]
   * @param {AbortSignal} [input.signal]
   * @returns {AsyncGenerator<object>}
   */
  async *stream({ decision, invoke, options = {}, switchPolicy = SwitchPolicy.AUTO, signal }) {
    const deadline = this.clock.now() + this.overallTimeoutMs;
    let candidateIndex = 0;
    let retriesOnCurrent = 0;
    let attemptsUsed = 0;
    let lastError = null;
    /** @type {StreamSession|null} */
    let session = null;

    while (candidateIndex < decision.chain.length) {
      const model = decision.chain[candidateIndex];
      const provider = this.registry.get(model.provider);

      if (!provider) {
        this.logger?.warn("streaming.candidate_vanished", { provider: model.provider });
        candidateIndex += 1;
        continue;
      }

      if (this.clock.now() >= deadline) {
        lastError = new AppError("The request took too long.", ErrorKind.TIMEOUT);
        break;
      }

      // A fresh session per attempt. The buffer reset is structural — there is
      // no "clear the buffer" step anyone can forget.
      session = new StreamSession({ model, provider: model.provider, attempt: attemptsUsed });
      attemptsUsed += 1;

      const started = this.clock.now();
      let firstTokenAt = null;
      const emitted = [];

      try {
        yield* this.#runAttempt({
          provider,
          model,
          invoke,
          options,
          signal,
          session,
          onFirstToken: () => {
            firstTokenAt = this.clock.now();
            // A point in time, not a duration: modelling first-token as a child
            // span would imply generation paused there. TTFT is the number
            // users feel, so it belongs on the trace as a marker.
            this.tracer.active()?.addEvent(
              "stream.first_token",
              { "provider.id": model.provider, ttftMs: firstTokenAt - started },
              firstTokenAt
            );
          },
          collect: (event) => emitted.push(event),
        });

        // A stream that ends with zero content is an error, not a success.
        // Silent quota exhaustion frequently manifests as an empty 200, and
        // treating it as success shows the user a blank reply.
        if (session.isEmpty) {
          throw new ProviderError(
            `${provider.name} returned an empty stream`,
            FailureKind.OUTAGE,
            { provider: provider.id }
          );
        }

        this.registry.recordSuccess(model.provider, this.clock.now() - started);
        this.#recordMetrics(model, "success", started, firstTokenAt, session);

        // The terminal event is emitted here, after the attempt has been
        // *validated* — never inside the attempt itself. A `done` forwarded
        // before validation lets a client finalise the message and then receive
        // a second `start` when the attempt turns out to have failed, which is
        // visibly broken and impossible to recover from client-side.
        yield doneEvent(model.id, model.provider, session.finishReason ?? "stop");
        return;
      } catch (raw) {
        const error = this.#normalise(raw, provider);
        lastError = error;
        this.#recordMetrics(model, "failure", started, firstTokenAt, session, error);

        // Cancellation is never a provider failure: counting it would open a
        // breaker on a healthy provider, so a user who cancels three long
        // generations takes it out of rotation for everyone.
        if (CancelledError.is(error)) {
          this.logger?.info("streaming.cancelled", {
            provider: model.provider,
            deltas: session.deltaCount,
          });
          throw error;
        }

        this.registry.recordFailure(model.provider, error);

        const next = this.retryPolicy.next({
          error,
          attemptsUsed,
          retriesOnCurrent,
          hasAlternative: candidateIndex + 1 < decision.chain.length,
          switchPolicy,
          cancelled: signal?.aborted === true,
          // The rule that prevents duplicated tokens.
          contentAlreadySent: session.hasEmittedContent,
          remainingBudgetMs: deadline - this.clock.now(),
        });

        this.logger?.warn("streaming.attempt_failed", {
          provider: model.provider,
          kind: error.failureKind,
          deltas: session.deltaCount,
          action: next.action,
          why: next.why,
        });

        if (next.action === RetryDecision.RETRY) {
          retriesOnCurrent += 1;
          this.metrics.increment("nova_routing_retries_total", {
            provider: model.provider,
            kind: error.failureKind,
          });
          if (next.delayMs > 0) await this.clock.sleep(next.delayMs, signal);
          continue;
        }

        if (next.action === RetryDecision.FAILOVER) {
          const to = decision.chain[candidateIndex + 1];
          this.metrics.increment("nova_routing_failovers_total", {
            from: model.provider,
            to: to.provider,
            reason: error.failureKind,
          });

          // Marked on the root span so the tail sampler keeps this trace at
          // 100%: a failover that ends up succeeding carries no error, and
          // nothing else would distinguish it from an ordinary request.
          this.tracer.active()?.setAttributes({ "routing.switched": true });

          // Emitted *before* the new attempt's tokens so the client clears its
          // partial render first. After, and the client interleaves two models'
          // output for the duration of the round trip.
          yield {
            type: StreamEventType.SWITCHED,
            from: { model: model.id, provider: model.provider },
            to: { model: to.id, provider: to.provider },
            reason: error.failureKind,
            message: `${model.displayName} ${phraseFor(error.failureKind)}. Switched to ${to.displayName}.`,
            discardPartial: session.hasEmittedContent,
          };

          candidateIndex += 1;
          retriesOnCurrent = 0;
          continue;
        }

        break; // SURFACE / ASK
      }
    }

    this.metrics.increment("nova_routing_exhausted_total", {
      reason: lastError?.failureKind ?? lastError?.kind ?? "unknown",
    });

    // A terminal event always ends the stream. A client that receives neither
    // `done` nor `error` is left with a spinner it can never resolve.
    yield errorEvent(
      lastError?.kind ?? ErrorKind.PROVIDER_UNAVAILABLE,
      lastError?.message ?? "No provider could serve this request."
    );
  }

  /**
   * One attempt: consume the provider's events, enforce the protocol, and apply
   * the stall timeouts.
   *
   * Two timeouts rather than one total duration. A legitimate long generation
   * runs for minutes while emitting steadily, and a total cap would truncate
   * exactly the requests users value most. Time-to-first-token plus inter-token
   * detects a *stall*, which is the actual failure.
   */
  async *#runAttempt({ provider, model, invoke, options, signal, session, onFirstToken, collect }) {
    const iterator = invoke(provider, model, { ...options, model: model.id, signal })[
      Symbol.asyncIterator
    ]();

    let sawFirstToken = false;

    try {
      while (true) {
        if (signal?.aborted) throw new CancelledError();

        const budget = sawFirstToken ? this.interTokenTimeoutMs : this.firstTokenTimeoutMs;
        const step = await Promise.race([iterator.next(), this.#stallTimer(budget, sawFirstToken)]);

        if (step === STALL) {
          throw new ProviderError(
            sawFirstToken
              ? `${provider.name} stalled mid-stream`
              : `${provider.name} did not start streaming`,
            FailureKind.TIMEOUT,
            { provider: provider.id }
          );
        }

        if (step.done) break;

        const event = step.value;
        if (!session.accept(event)) continue; // normalisation dropped it

        if (event.type === StreamEventType.DELTA && !sawFirstToken) {
          sawFirstToken = true;
          onFirstToken?.();
        }

        if (event.type === StreamEventType.ERROR) {
          throw new ProviderError(event.message ?? "stream error", FailureKind.OUTAGE, {
            provider: provider.id,
          });
        }

        // `done` is withheld: the caller emits it once the attempt is known to
        // have produced content. Everything else flows straight through.
        if (event.type === StreamEventType.DONE) continue;

        collect?.(event);
        yield event;
      }
    } finally {
      // Releases the provider's upstream reader when the consumer stops early —
      // a `return` from the caller's `for await` lands here.
      await iterator.return?.().catch(() => {});
    }
  }

  #stallTimer(ms, sawFirstToken) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(STALL), ms);
      timer.unref?.();
      void sawFirstToken;
    });
  }

  #normalise(raw, provider) {
    if (CancelledError.is(raw) || raw?.name === "AbortError") return new CancelledError();
    if (ProviderError.is(raw)) return raw;
    if (AppError.is(raw)) return raw;
    return new ProviderError(`${provider.name} failed mid-stream`, FailureKind.API_ERROR, {
      provider: provider.id,
      cause: raw instanceof Error ? raw : new Error(String(raw)),
    });
  }

  #recordMetrics(model, outcome, started, firstTokenAt, session, error = null) {
    const now = this.clock.now();
    this.metrics.observe("nova_stream_duration_seconds", (now - started) / 1000, {
      provider: model.provider,
      model: model.id,
      // Labelled by outcome, because a stream that died at token three and one
      // that ran to completion have very different durations and averaging
      // them together describes neither.
      outcome,
    });
    if (firstTokenAt !== null) {
      // TTFT is what users actually feel: a 30s generation that starts in 300ms
      // feels fast, a 3s one that starts after 2.5s feels broken.
      this.metrics.observe("nova_stream_ttft_seconds", (firstTokenAt - started) / 1000, {
        provider: model.provider,
        model: model.id,
      });
    }
    this.metrics.increment("nova_provider_attempts_total", {
      provider: model.provider,
      model: model.id,
      outcome,
    });

    // A stream that died at token three still consumed the prompt. Recording it
    // is what makes "wasted spend" a measured number rather than a guess.
    this.usageRecorder?.record({
      provider: model.provider,
      model: model.id,
      attempt: session?.attempt != null ? session.attempt + 1 : 1,
      outcome: outcome === "success" ? "success" : CancelledError.is(error) ? "cancelled" : "failure",
      failureKind: error?.failureKind ?? null,
      streaming: true,
      usage: session?.usage ?? null,
      latencyMs: now - started,
      ttftMs: firstTokenAt === null ? null : firstTokenAt - started,
    });
  }
}

const STALL = Symbol("stall");

function phraseFor(kind) {
  return (
    {
      quota: "reached its quota",
      rate_limit: "hit its rate limit",
      timeout: "timed out",
      outage: "is unavailable",
      auth: "rejected our credentials",
      api_error: "returned an error",
    }[kind] ?? "failed"
  );
}
