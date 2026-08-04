import { BaseProvider } from "./BaseProvider.js";
import { HttpClient, mapHttpError } from "./HttpClient.js";
import { parseSseStream, parseJsonPayload } from "./SseParser.js";
import { ProviderError, FailureKind, UnsupportedCapabilityError } from "../../../domain/errors/index.js";
import {
  startEvent,
  deltaEvent,
  reasoningEvent,
  toolCallEvent,
  usageEvent,
  doneEvent,
} from "../../../domain/streaming/StreamEvent.js";

/**
 * The OpenAI Chat Completions dialect.
 *
 * Seven of the eight Phase 1 providers speak it, so their adapters are
 * configuration — id, name, base URL, env key — with zero behavioural code in
 * the common case. That is the deliberate onboarding filter: dialect-compatible
 * providers are near-free to add, so we add many
 * (docs/backend/03-provider-system.md#two-tiers-deliberately).
 *
 * **The trade-off, accepted:** a change here affects seven adapters at once.
 * The shared contract suite is the mitigation — a regression fails seven test
 * files loudly, which is exactly the behaviour we want.
 *
 * Everything provider-specific stops here. Nothing above this file ever sees a
 * `choices[0].delta.content`.
 */
export class OpenAIDialectProvider extends BaseProvider {
  /**
   * @param {object} config — BaseProvider's, plus:
   * @param {string} config.baseURL
   * @param {HttpClient} [config.http]
   * @param {number} [config.timeoutMs]
   * @param {string} [config.embeddingModel]
   */
  constructor(config) {
    super(config);
    this.baseURL = (config.baseURL ?? config.settings?.baseURL ?? "").replace(/\/$/, "");
    this.http = config.http ?? new HttpClient({ clock: config.clock });
    this.timeoutMs = config.timeoutMs ?? config.settings?.timeoutMs ?? 60_000;
    this.embeddingModel = config.embeddingModel ?? null;
  }

  /** Overridden where a provider needs extra headers (e.g. OpenRouter attribution). */
  get headers() {
    return {
      "Content-Type": "application/json",
      ...(this.credential ? { Authorization: `Bearer ${this.credential.expose()}` } : {}),
    };
  }

  /** Overridden where a provider deviates from the shared status mapping. */
  mapError = (status, body, cause) =>
    mapHttpError(status, body, cause, { providerId: this.id, providerName: this.name });

  /**
   * Build the request body.
   *
   * Only the closed option set crosses this boundary. A provider-specific
   * parameter belongs in that adapter's config, never in the shared signature —
   * the moment options become an open bag forwarded upstream, the abstraction
   * is dead while still appearing to work.
   */
  buildBody(messages, options, extra = {}) {
    const body = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
      top_p: options.topP ?? 1,
      ...extra,
    };

    if (options.stop?.length) body.stop = options.stop;
    if (Number.isFinite(options.seed)) body.seed = options.seed;

    // Structured output. `json_schema` is strictly stronger than `json_object`:
    // one guarantees parseable, the other guarantees the right shape.
    if (options.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: options.jsonSchema };
    } else if (options.json) {
      body.response_format = { type: "json_object" };
    }

    return body;
  }

  async post(path, payload, { stream = false, signal } = {}) {
    return this.http.request(
      `${this.baseURL}${path}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(payload) },
      { timeoutMs: this.timeoutMs, signal, mapError: this.mapError, stream }
    );
  }

  async generate(messages, options = {}) {
    this.assertSupported("generate", options.model);

    const data = await this.post("/chat/completions", this.buildBody(messages, options), {
      signal: options.signal,
    });

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";

    // An empty completion is not a success. Silent quota exhaustion often
    // manifests this way, and returning it would show the user a blank reply
    // while the router counted a win.
    if (!text && !choice?.message?.tool_calls?.length) {
      throw new ProviderError(`${this.name} returned an empty response`, FailureKind.OUTAGE, {
        provider: this.id,
      });
    }

    return {
      text,
      usage: normaliseUsage(data.usage),
      model: data.model ?? options.model,
      finishReason: choice?.finish_reason ?? "stop",
    };
  }

  /**
   * Stream, normalised to `StreamEvent`s.
   *
   * The frame-level hazards (split frames, multiple frames per chunk, malformed
   * frames, `[DONE]`, reader release) are all handled by `parseSseStream`; what
   * remains here is dialect translation.
   */
  async *stream(messages, options = {}) {
    this.assertSupported("stream", options.model);

    const response = await this.post(
      "/chat/completions",
      this.buildBody(messages, options, {
        stream: true,
        // Most dialect providers only report usage on a stream when asked.
        // Without it, cost accounting silently reads zero for every stream.
        stream_options: { include_usage: true },
      }),
      { stream: true, signal: options.signal }
    );

    yield startEvent(options.model, this.id);

    let finishReason = "stop";

    for await (const payload of parseSseStream(response.body, { signal: options.signal })) {
      const frame = parseJsonPayload(payload);
      if (!frame) continue; // malformed frame — skip, never fatal

      // Some providers deliver an error mid-stream as a normal frame rather
      // than closing the connection.
      if (frame.error) {
        throw this.mapError(undefined, JSON.stringify(frame.error));
      }

      if (frame.usage) yield usageEvent(normaliseUsage(frame.usage) ?? {});

      const choice = frame.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};

      // Reasoning traces are a separate event: users want them collapsible, and
      // they must not be persisted as the assistant's answer.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield reasoningEvent(reasoning);

      if (delta.content) yield deltaEvent(delta.content);

      for (const call of delta.tool_calls ?? []) {
        yield toolCallEvent(call.id, call.function?.name, call.function?.arguments);
      }
    }

    yield doneEvent(options.model, this.id, finishReason);
  }

  async vision(images, prompt, options = {}) {
    this.assertSupported("vision", options.model);
    const content = [
      { type: "text", text: prompt },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: image.url ?? image.dataUrl ?? image },
      })),
    ];
    return this.generate([{ role: "user", content }], options);
  }

  async toolCalling(messages, tools, options = {}) {
    this.assertSupported("toolCalling", options.model);
    const data = await this.post(
      "/chat/completions",
      this.buildBody(messages, options, {
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: options.toolChoice ?? "auto",
      }),
      { signal: options.signal }
    );
    const message = data.choices?.[0]?.message ?? {};
    return {
      text: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      })),
      model: data.model ?? options.model,
      usage: normaliseUsage(data.usage),
    };
  }

  async embeddings(inputs, options = {}) {
    const model = options.model && this.models.some((m) => m.id === options.model)
      ? options.model
      : this.embeddingModel;
    if (!model) throw new UnsupportedCapabilityError(this.id, "embeddings");

    const data = await this.post(
      "/embeddings",
      { model, input: inputs },
      { signal: options.signal }
    );
    return (data.data ?? []).map((entry) => entry.embedding);
  }

  /**
   * Confirm which catalog models the endpoint actually serves.
   *
   * A probe may only ever **remove** a model, never add one: `/models` returns
   * identifiers, not capability descriptions, and inferring capability from a
   * model name is string matching against a convention no provider guarantees
   * (docs/backend/03-provider-system.md#capability-detection).
   */
  async listModels() {
    if (!this.isConfigured) return this.models;
    try {
      const data = await this.http.request(
        `${this.baseURL}/models`,
        { headers: this.headers },
        { timeoutMs: 8000, mapError: this.mapError }
      );
      const served = new Set((data.data ?? []).map((entry) => entry.id));
      const confirmed = this.models.filter((model) => served.has(model.id));
      // An endpoint that lists nothing we know about is more likely a shape we
      // do not understand than a provider serving nothing.
      return confirmed.length ? confirmed : this.models;
    } catch {
      return this.models;
    }
  }

  /** The cheapest call that proves the endpoint answers. Never a completion. */
  async health() {
    if (!this.isConfigured) return { ok: false, latencyMs: null, error: "not configured" };
    const started = this.clock?.now?.() ?? Date.now();
    try {
      await this.http.request(
        `${this.baseURL}/models`,
        { headers: this.headers },
        { timeoutMs: 8000, mapError: this.mapError }
      );
      return { ok: true, latencyMs: (this.clock?.now?.() ?? Date.now()) - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: (this.clock?.now?.() ?? Date.now()) - started,
        error: error.message,
      };
    }
  }

  supportsEmbeddings() {
    return Boolean(this.embeddingModel) || super.supportsEmbeddings();
  }
}

/** Providers disagree on usage field names; the domain sees one shape. */
function normaliseUsage(usage) {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens ?? usage.promptTokens ?? null,
    completionTokens: usage.completion_tokens ?? usage.completionTokens ?? null,
    totalTokens: usage.total_tokens ?? usage.totalTokens ?? null,
  };
}
