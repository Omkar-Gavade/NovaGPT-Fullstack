import { BaseProvider } from "../../shared/BaseProvider.js";
import { HttpClient, mapHttpError } from "../../shared/HttpClient.js";
import { parseSseStream, parseJsonPayload } from "../../shared/SseParser.js";
import { ProviderError, FailureKind, UnsupportedCapabilityError } from "../../../../domain/errors/index.js";
import {
  startEvent,
  deltaEvent,
  usageEvent,
  doneEvent,
} from "../../../../domain/streaming/StreamEvent.js";

/**
 * Google AI Studio (Gemini) — the only Phase 1 provider not speaking the
 * OpenAI dialect, and the reason `BaseProvider` exists separately from
 * `OpenAIDialectProvider`.
 *
 * It differs in almost every dimension:
 *
 *   - `contents` with `parts`, not `messages` with `content`
 *   - the assistant role is called `model`
 *   - the system prompt is a separate `systemInstruction`, not a message
 *   - auth is a query parameter or `x-goog-api-key`, not a bearer token
 *   - the model id is in the URL path, not the body
 *   - streaming is `?alt=sse` on a different endpoint
 *
 * Every one of those quirks stops inside this file. Nothing above it knows
 * Gemini exists — which is the property the whole provider abstraction is for.
 *
 * Uses the REST API directly rather than `@google/generative-ai`: the SDK
 * bundles its own retry and error handling, which would fight the router's, and
 * hides the raw status codes the error taxonomy is built from.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export const descriptor = {
  id: "gemini",
  name: "Gemini",
  dialect: "native",
  adapterVersion: "1.0.0",
  envKeys: ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"],
  models: [
    {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      capabilities: {
        streaming: true, vision: true, video: true, pdf: true,
        json: true, structuredOutput: true, toolCalling: true,
        contextWindow: 1_000_000, maxOutputTokens: 8192,
        reasoning: 82, coding: 80, multilingual: 85, speed: 96,
      },
      tier: "free", costBand: "$", verifiedAt: "2026-08-01",
    },
    {
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      capabilities: {
        streaming: true, vision: true, video: true, pdf: true,
        json: true, structuredOutput: true, toolCalling: true,
        contextWindow: 2_000_000, maxOutputTokens: 8192,
        reasoning: 94, coding: 90, multilingual: 88, speed: 74,
      },
      tier: "paid", costBand: "$$", verifiedAt: "2026-08-01",
    },
    {
      id: "text-embedding-004",
      displayName: "Gemini Embeddings",
      capabilities: { embeddings: true, contextWindow: 2_048, maxOutputTokens: 1 },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends BaseProvider {
  constructor(config) {
    super(config);
    this.baseURL = (config.settings?.baseURL ?? API_ROOT).replace(/\/$/, "");
    this.http = config.http ?? new HttpClient({ clock: config.clock });
    this.timeoutMs = config.settings?.timeoutMs ?? 60_000;
  }

  /**
   * Header auth rather than the `?key=` query parameter.
   *
   * A key in a URL ends up in access logs, proxy logs, and error messages that
   * quote the request line — the exact leak paths the security model is built
   * to close (docs/backend/10-security.md).
   */
  get headers() {
    return {
      "Content-Type": "application/json",
      ...(this.credential ? { "x-goog-api-key": this.credential.expose() } : {}),
    };
  }

  mapError = (status, body, cause) => {
    // Gemini reports free-tier exhaustion as 429 with RESOURCE_EXHAUSTED, which
    // the shared mapper would read as a rate limit — a 60s cooldown instead of
    // the 15 minutes a quota needs.
    if (status === 429 && /RESOURCE_EXHAUSTED|quota/i.test(body ?? "")) {
      return new ProviderError(`${this.name} quota reached`, FailureKind.QUOTA, {
        provider: this.id,
        upstreamStatus: status,
      });
    }
    return mapHttpError(status, body, cause, { providerId: this.id, providerName: this.name });
  };

  /**
   * Domain messages → Gemini `contents`.
   *
   * The system prompt is extracted rather than mapped: Gemini rejects a
   * `system` role inside `contents` and expects `systemInstruction` alongside.
   */
  toGemini(messages) {
    const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content));
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: toParts(message.content),
      }));
    return {
      contents,
      systemInstruction: system.length ? { parts: [{ text: system.join("\n\n") }] } : undefined,
    };
  }

  generationConfig(options) {
    const config = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 2048,
      topP: options.topP ?? 0.95,
    };
    if (options.stop?.length) config.stopSequences = options.stop;
    if (options.json || options.jsonSchema) config.responseMimeType = "application/json";
    // Native schema enforcement, which is why these models declare
    // `structuredOutput` and not merely `json`.
    if (options.jsonSchema?.schema) config.responseSchema = options.jsonSchema.schema;
    return config;
  }

  async generate(messages, options = {}) {
    this.assertSupported("generate", options.model);
    const { contents, systemInstruction } = this.toGemini(messages);

    const data = await this.http.request(
      `${this.baseURL}/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: this.generationConfig(options),
        }),
      },
      { timeoutMs: this.timeoutMs, signal: options.signal, mapError: this.mapError }
    );

    const candidate = data.candidates?.[0];
    const text = partsToText(candidate?.content?.parts);

    // A safety block returns a candidate with no parts and a finishReason of
    // SAFETY. That is the request being refused, not the provider failing —
    // api_error, so the router surfaces it rather than retrying elsewhere where
    // it would be refused identically.
    if (!text) {
      const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason;
      throw new ProviderError(
        reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
          ? `${this.name} declined to answer this request`
          : `${this.name} returned an empty response`,
        reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
          ? FailureKind.API_ERROR
          : FailureKind.OUTAGE,
        { provider: this.id }
      );
    }

    return {
      text,
      usage: normaliseUsage(data.usageMetadata),
      model: options.model,
      finishReason: candidate?.finishReason ?? "STOP",
    };
  }

  async *stream(messages, options = {}) {
    this.assertSupported("stream", options.model);
    const { contents, systemInstruction } = this.toGemini(messages);

    const response = await this.http.request(
      `${this.baseURL}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: this.generationConfig(options),
        }),
      },
      { timeoutMs: this.timeoutMs, signal: options.signal, mapError: this.mapError, stream: true }
    );

    yield startEvent(options.model, this.id);

    let finishReason = "STOP";
    let usage = null;

    // Gemini streams SSE with no `[DONE]` terminator, so the parser runs to
    // stream end rather than watching for one.
    for await (const payload of parseSseStream(response.body, {
      signal: options.signal,
      terminator: null,
    })) {
      const frame = parseJsonPayload(payload);
      if (!frame) continue;

      if (frame.error) throw this.mapError(undefined, JSON.stringify(frame.error));
      if (frame.usageMetadata) usage = normaliseUsage(frame.usageMetadata);

      const candidate = frame.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;

      const text = partsToText(candidate.content?.parts);
      if (text) yield deltaEvent(text);
    }

    if (usage) yield usageEvent(usage);
    yield doneEvent(options.model, this.id, finishReason);
  }

  async vision(images, prompt, options = {}) {
    this.assertSupported("vision", options.model);
    const parts = [
      { text: prompt },
      ...images.map((image) => ({
        inlineData: {
          mimeType: image.mimeType ?? "image/png",
          data: image.data ?? image.base64 ?? image,
        },
      })),
    ];
    return this.generate([{ role: "user", content: parts }], options);
  }

  async embeddings(inputs, options = {}) {
    const model = options.model ?? "text-embedding-004";
    if (!this.models.some((m) => m.id === model && m.supports("embeddings"))) {
      throw new UnsupportedCapabilityError(this.id, "embeddings");
    }

    const data = await this.http.request(
      `${this.baseURL}/models/${encodeURIComponent(model)}:batchEmbedContents`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          requests: inputs.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
      { timeoutMs: this.timeoutMs, signal: options.signal, mapError: this.mapError }
    );

    return (data.embeddings ?? []).map((entry) => entry.values);
  }

  async listModels() {
    if (!this.isConfigured) return this.models;
    try {
      const data = await this.http.request(
        `${this.baseURL}/models`,
        { headers: this.headers },
        { timeoutMs: 8000, mapError: this.mapError }
      );
      // Gemini prefixes ids with `models/`.
      const served = new Set((data.models ?? []).map((m) => m.name?.replace(/^models\//, "")));
      const confirmed = this.models.filter((m) => served.has(m.id));
      return confirmed.length ? confirmed : this.models;
    } catch {
      return this.models;
    }
  }

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
}

const textOf = (content) =>
  typeof content === "string" ? content : partsToText(content) || JSON.stringify(content);

/** Domain content → Gemini parts. Already-shaped parts pass through. */
function toParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return { text: part };
      if (part.text || part.inlineData) return part; // already Gemini-shaped
      if (part.type === "text") return { text: part.text };
      if (part.type === "image_url") {
        // OpenAI-dialect image parts arrive as data URLs from shared callers.
        const url = part.image_url?.url ?? "";
        const match = /^data:([^;]+);base64,(.+)$/.exec(url);
        return match
          ? { inlineData: { mimeType: match[1], data: match[2] } }
          : { text: `[image: ${url}]` };
      }
      return { text: JSON.stringify(part) };
    });
  }
  return [{ text: String(content ?? "") }];
}

const partsToText = (parts) =>
  (parts ?? [])
    .map((part) => part?.text ?? "")
    .join("");

function normaliseUsage(metadata) {
  if (!metadata) return null;
  return {
    promptTokens: metadata.promptTokenCount ?? null,
    completionTokens: metadata.candidatesTokenCount ?? null,
    totalTokens: metadata.totalTokenCount ?? null,
  };
}
