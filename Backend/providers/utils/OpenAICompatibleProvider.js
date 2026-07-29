import { Provider, ProviderError, FailureKind, UnsupportedCapabilityError } from "../interfaces/Provider.js";
import { resilientFetch } from "./reliability.js";

/**
 * Adapter for every provider that speaks the OpenAI Chat Completions dialect —
 * OpenAI, DeepSeek, Kimi, Qwen, Groq, Mistral, OpenRouter, Ollama and any
 * custom OpenAI-compatible endpoint.
 *
 * All HTTP goes through `resilientFetch` (timeout + retry + cancellation +
 * error mapping), so concrete providers only supply id/name/baseURL/env key.
 */
export class OpenAICompatibleProvider extends Provider {
  constructor(config) {
    super(config);
    this.requiresKey = config.requiresKey !== false; // Ollama runs keyless
    this.embeddingModel = config.embeddingModel || null;
    this.timeoutMs = config.timeoutMs || 60_000;
  }

  get isConfigured() {
    return this.requiresKey ? Boolean(this.apiKey) : Boolean(this.baseURL);
  }

  get headers() {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** Translate an HTTP status / body into the router's normalized taxonomy. */
  mapError = (status, body, cause) => {
    if (cause?.name === "AbortError" || (!status && /timeout/i.test(cause?.message || ""))) {
      return new ProviderError(`${this.name} timed out`, FailureKind.TIMEOUT, { provider: this.id });
    }
    if (status === 401 || status === 403) {
      return new ProviderError(`${this.name} rejected the credentials`, FailureKind.AUTH, { status, provider: this.id });
    }
    if (status === 429) {
      const quota = /quota|billing|credit|insufficient/i.test(body || "");
      const retryAfter = Number(/retry.?after["\s:]+(\d+)/i.exec(body || "")?.[1]) || undefined;
      return new ProviderError(
        quota ? `${this.name} quota reached` : `${this.name} rate limit reached`,
        quota ? FailureKind.QUOTA : FailureKind.RATE_LIMIT,
        { status, provider: this.id, retryAfter }
      );
    }
    if (!status || status >= 500) {
      return new ProviderError(`${this.name} is unavailable`, FailureKind.OUTAGE, { status, provider: this.id });
    }
    return new ProviderError(body || cause?.message || `${this.name} request failed`, FailureKind.API_ERROR, {
      status,
      provider: this.id,
    });
  };

  async post(path, payload, { stream = false, signal, retry } = {}) {
    const res = await resilientFetch(
      `${this.baseURL}${path}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(payload) },
      { timeoutMs: this.timeoutMs, signal, mapError: this.mapError, retry: retry ?? !stream }
    );
    return stream ? res : res.json();
  }

  /** Apply structured-output options the OpenAI dialect understands. */
  buildBody(messages, options, extra = {}) {
    const responseFormat = options.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: options.jsonSchema } }
      : options.json
      ? { response_format: { type: "json_object" } }
      : {};
    return {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
      top_p: options.topP ?? 1,
      ...responseFormat,
      ...extra,
    };
  }

  async generate(messages, options = {}) {
    const data = await this.post("/chat/completions", this.buildBody(messages, options), { signal: options.signal });
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? null,
      model: data.model ?? options.model,
    };
  }

  async *stream(messages, options = {}) {
    const res = await this.post("/chat/completions", this.buildBody(messages, options, { stream: true }), {
      stream: true,
      signal: options.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            /* keep-alive or partial frame */
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {}); // release upstream on early return / abort
    }
  }

  async vision(images, prompt, options = {}) {
    if (!this.supportsVision()) throw new UnsupportedCapabilityError(this.id, "vision");
    const content = [
      { type: "text", text: prompt },
      ...images.map((img) => ({ type: "image_url", image_url: { url: img.url || img } })),
    ];
    return this.generate([{ role: "user", content }], options);
  }

  async embeddings(inputs, options = {}) {
    const model = options.model || this.embeddingModel;
    if (!model) throw new UnsupportedCapabilityError(this.id, "embeddings");
    const data = await this.post("/embeddings", { model, input: inputs }, { signal: options.signal });
    return data.data?.map((d) => d.embedding) ?? [];
  }

  async toolCalling(messages, tools, options = {}) {
    if (!this.supportsTools()) throw new UnsupportedCapabilityError(this.id, "toolCalling");
    const data = await this.post(
      "/chat/completions",
      this.buildBody(messages, options, { tools, tool_choice: options.toolChoice ?? "auto" }),
      { signal: options.signal }
    );
    const message = data.choices?.[0]?.message ?? {};
    return { text: message.content ?? "", toolCalls: message.tool_calls ?? [], model: data.model };
  }

  /** Ask the endpoint what it serves; fall back to the catalog on failure. */
  async listModels() {
    if (!this.isConfigured) return this.models;
    try {
      const res = await resilientFetch(
        `${this.baseURL}/models`,
        { headers: this.headers },
        { timeoutMs: 8000, mapError: this.mapError, retry: false }
      );
      const data = await res.json();
      const ids = new Set((data.data || []).map((m) => m.id));
      // keep catalog entries the endpoint confirms it can serve
      const confirmed = this.models.filter((m) => ids.has(m.id));
      return confirmed.length ? confirmed : this.models;
    } catch {
      return this.models;
    }
  }

  supportsEmbeddings() {
    return Boolean(this.embeddingModel);
  }
}
