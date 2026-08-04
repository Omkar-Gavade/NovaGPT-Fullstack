import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * GroqCloud — the fastest tokens/sec available at any price.
 *
 * The router's default when latency is what matters. Open-weight models only,
 * on a free developer tier with per-model RPM/RPD caps.
 */
export const descriptor = {
  id: "groq",
  name: "Groq",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["GROQ_API_KEY"],
  models: [
    {
      id: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 32_768,
        reasoning: 80, coding: 78, multilingual: 70, speed: 94,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
    {
      id: "llama-3.1-8b-instant",
      displayName: "Llama 3.1 8B",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 72, coding: 68, multilingual: 62, speed: 99,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
    {
      id: "openai/gpt-oss-120b",
      displayName: "GPT-OSS 120B",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 32_768,
        reasoning: 88, coding: 86, multilingual: 78, speed: 96,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({ ...config, baseURL: config.settings?.baseURL ?? "https://api.groq.com/openai/v1" });
  }
}
