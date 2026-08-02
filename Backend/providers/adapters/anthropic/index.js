import { Provider, ProviderError, FailureKind, UnsupportedCapabilityError } from "../../interfaces/Provider.js";
import { modelsFor } from "../../registry/catalog.js";
import { resilientFetch } from "../../utils/reliability.js";

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

/** Anthropic Claude adapter (native Messages API). */
export class ClaudeProvider extends Provider {
  constructor() {
    super({
      id: "claude",
      name: "Claude",
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: API,
      models: modelsFor("claude"),
    });
    this.timeoutMs = 60_000;
  }

  get headers() {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": VERSION,
    };
  }

  mapError = (status, body, cause) => {
    if (cause?.name === "AbortError" || (!status && /timeout/i.test(cause?.message || ""))) {
      return new ProviderError("Claude timed out", FailureKind.TIMEOUT, { provider: this.id });
    }
    if (status === 401 || status === 403) {
      return new ProviderError("Claude rejected the credentials", FailureKind.AUTH, { status, provider: this.id });
    }
    if (status === 429) {
      const quota = /credit|quota|billing/i.test(body || "");
      return new ProviderError(
        quota ? "Claude quota reached" : "Claude rate limit reached",
        quota ? FailureKind.QUOTA : FailureKind.RATE_LIMIT,
        { status, provider: this.id }
      );
    }
    if (!status || status >= 500) {
      return new ProviderError("Claude is unavailable", FailureKind.OUTAGE, { status, provider: this.id });
    }
    return new ProviderError(body || "Claude request failed", FailureKind.API_ERROR, { status, provider: this.id });
  };

  /** Anthropic takes the system prompt as a top-level field, not a message. */
  split(messages, options) {
    let system = messages.find((m) => m.role === "system")?.content || options.systemPrompt || "";
    // Anthropic has no JSON mode; steer it with a system instruction instead.
    if (options.json || options.jsonSchema) system = `${system}\nRespond with valid JSON only.`.trim();
    const rest = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    return { system, messages: rest };
  }

  async post(payload, { stream = false, signal } = {}) {
    const res = await resilientFetch(
      `${this.baseURL}/messages`,
      { method: "POST", headers: this.headers, body: JSON.stringify(payload) },
      { timeoutMs: this.timeoutMs, signal, mapError: this.mapError, retry: !stream }
    );
    return stream ? res : res.json();
  }

  body(messages, options, extra = {}) {
    const { system, messages: msgs } = this.split(messages, options);
    return {
      model: options.model || "claude-sonnet-4-5",
      messages: msgs,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 1,
      ...(system ? { system } : {}),
      ...extra,
    };
  }

  async generate(messages, options = {}) {
    const data = await this.post(this.body(messages, options), { signal: options.signal });
    return {
      text: data.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "",
      usage: data.usage ?? null,
      model: data.model,
    };
  }

  async *stream(messages, options = {}) {
    const res = await this.post(this.body(messages, options, { stream: true }), {
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
          try {
            const evt = JSON.parse(trimmed.slice(5).trim());
            if (evt.type === "content_block_delta" && evt.delta?.text) yield evt.delta.text;
          } catch {
            /* partial frame */
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async vision(images, prompt, options = {}) {
    const content = [
      ...images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mimeType || "image/png", data: img.data || img },
      })),
      { type: "text", text: prompt },
    ];
    return this.generate([{ role: "user", content }], options);
  }

  async embeddings() {
    throw new UnsupportedCapabilityError(this.id, "embeddings");
  }

  supportsEmbeddings() {
    return false;
  }

  async toolCalling(messages, tools, options = {}) {
    const data = await this.post(this.body(messages, options, { tools }));
    return {
      text: data.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "",
      toolCalls: data.content?.filter((c) => c.type === "tool_use") ?? [],
      model: data.model,
    };
  }
}
