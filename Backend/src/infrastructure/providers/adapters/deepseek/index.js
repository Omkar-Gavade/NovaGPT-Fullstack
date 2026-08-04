import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * DeepSeek — the strongest reasoning-per-dollar in the Phase 1 set.
 *
 * Paid but cheap, and bring-your-own-key. `deepseek-reasoner` emits chain of
 * thought in `reasoning_content`, which the dialect base already routes to a
 * separate `reasoning` event so it is never persisted as the answer.
 */
export const descriptor = {
  id: "deepseek",
  name: "DeepSeek",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["DEEPSEEK_API_KEY"],
  models: [
    {
      id: "deepseek-chat",
      displayName: "DeepSeek Chat",
      capabilities: {
        streaming: true, json: true, structuredOutput: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 90, coding: 94, multilingual: 74, speed: 80,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
    {
      id: "deepseek-reasoner",
      displayName: "DeepSeek Reasoner",
      capabilities: {
        // No tools and no JSON mode: the reasoning model does not support them,
        // and claiming otherwise would route a request that fails at dispatch.
        streaming: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 96, coding: 92, multilingual: 72, speed: 55,
      },
      tier: "paid", costBand: "$$", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({ ...config, baseURL: config.settings?.baseURL ?? "https://api.deepseek.com/v1" });
  }
}
