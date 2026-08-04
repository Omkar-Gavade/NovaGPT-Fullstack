import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * Qwen (Alibaba DashScope) — best-in-class multilingual, especially CJK, plus a
 * 256K window that makes it the only non-Gemini option for very long context.
 *
 * Region-dependent endpoints: the international endpoint is the default and the
 * mainland one is reachable through `settings.baseURL`.
 */
export const descriptor = {
  id: "qwen",
  name: "Qwen",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  models: [
    {
      id: "qwen-plus",
      displayName: "Qwen Plus",
      capabilities: {
        streaming: true, vision: true, json: true, toolCalling: true,
        contextWindow: 256_000, maxOutputTokens: 8192,
        reasoning: 83, coding: 82, multilingual: 96, speed: 85,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
    {
      id: "qwen-turbo",
      displayName: "Qwen Turbo",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 74, coding: 72, multilingual: 92, speed: 94,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({
      ...config,
      baseURL: config.settings?.baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      embeddingModel: "text-embedding-v3",
    });
  }
}
