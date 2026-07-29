import { GoogleGenerativeAI } from "@google/generative-ai";
import { Provider, ProviderError, FailureKind } from "../../interfaces/Provider.js";
import { modelsFor } from "../../registry/catalog.js";
import { withRetry } from "../../utils/reliability.js";

/** Google Gemini adapter (native SDK). */
export class GeminiProvider extends Provider {
  constructor() {
    super({
      id: "gemini",
      name: "Gemini",
      apiKey: process.env.GEMINI_API_KEY,
      models: modelsFor("gemini"),
    });
    this.client = this.apiKey ? new GoogleGenerativeAI(this.apiKey) : null;
  }

  toProviderError(err) {
    const status = err?.status ?? err?.response?.status;
    const message = err?.message || "Gemini request failed";
    if (status === 429 || /quota|exhausted/i.test(message)) {
      return new ProviderError("Gemini quota reached", FailureKind.QUOTA, { status, provider: this.id });
    }
    if (status === 503 || /overload|unavailable/i.test(message)) {
      return new ProviderError("Gemini is unavailable", FailureKind.OUTAGE, { status, provider: this.id });
    }
    if (status === 401 || status === 403) {
      return new ProviderError("Gemini rejected the credentials", FailureKind.AUTH, { status, provider: this.id });
    }
    return new ProviderError(message, FailureKind.API_ERROR, { status, provider: this.id });
  }

  /** Chat messages -> Gemini `contents`; system prompt rides as systemInstruction. */
  toGemini(messages, options) {
    const system = messages.find((m) => m.role === "system")?.content || options.systemPrompt;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
      }));
    return { system, contents };
  }

  model(options) {
    const { system } = this.toGemini([], options);
    return this.client.getGenerativeModel({
      model: options.model || "gemini-2.5-flash",
      ...(system ? { systemInstruction: system } : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2048,
        topP: options.topP ?? 0.95,
        // native structured output
        ...(options.json || options.jsonSchema ? { responseMimeType: "application/json" } : {}),
        ...(options.jsonSchema?.schema ? { responseSchema: options.jsonSchema.schema } : {}),
      },
    });
  }

  async generate(messages, options = {}) {
    if (!this.client) throw new ProviderError("Gemini is not configured", FailureKind.AUTH, { provider: this.id });
    const { system, contents } = this.toGemini(messages, options);
    try {
      const model = this.model({ ...options, systemPrompt: system });
      const result = await withRetry(() => model.generateContent({ contents }), { signal: options.signal });
      return {
        text: result.response.text(),
        usage: result.response.usageMetadata ?? null,
        model: options.model || "gemini-2.5-flash",
      };
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  async *stream(messages, options = {}) {
    if (!this.client) throw new ProviderError("Gemini is not configured", FailureKind.AUTH, { provider: this.id });
    const { system, contents } = this.toGemini(messages, options);
    try {
      const model = this.model({ ...options, systemPrompt: system });
      // one retry to *establish* the stream; deltas aren't retried mid-flight
      const result = await withRetry(() => model.generateContentStream({ contents }), {
        retries: 1,
        signal: options.signal,
      });
      for await (const chunk of result.stream) {
        if (options.signal?.aborted) return;
        const text = chunk.text();
        if (text) yield text;
      }
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  supportsEmbeddings() {
    return true;
  }

  async vision(images, prompt, options = {}) {
    const parts = [
      { text: prompt },
      ...images.map((img) => ({
        inlineData: { mimeType: img.mimeType || "image/png", data: img.data || img },
      })),
    ];
    try {
      const model = this.model(options);
      const result = await model.generateContent({ contents: [{ role: "user", parts }] });
      return { text: result.response.text(), model: options.model || "gemini-2.5-flash" };
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  async embeddings(inputs, options = {}) {
    try {
      const model = this.client.getGenerativeModel({ model: options.model || "text-embedding-004" });
      const out = await Promise.all(inputs.map((text) => model.embedContent(text)));
      return out.map((o) => o.embedding.values);
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  async toolCalling(messages, tools, options = {}) {
    const { contents } = this.toGemini(messages, options);
    try {
      const model = this.client.getGenerativeModel({
        model: options.model || "gemini-2.5-flash",
        tools: [{ functionDeclarations: tools }],
      });
      const result = await model.generateContent({ contents });
      const calls = result.response.functionCalls?.() ?? [];
      return { text: result.response.text(), toolCalls: calls, model: options.model };
    } catch (err) {
      throw this.toProviderError(err);
    }
  }
}
