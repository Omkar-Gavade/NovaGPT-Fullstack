import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * Zhipu AI (GLM) — GLM-4-Flash is permanently free with a solid capability
 * floor, which makes it a reliable failover destination rather than a first
 * choice. The free terms carry non-commercial carve-outs.
 */
export const descriptor = {
  id: "zhipu",
  name: "GLM",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["ZHIPU_API_KEY", "GLM_API_KEY"],
  models: [
    {
      id: "glm-4-flash",
      displayName: "GLM-4 Flash",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 4096,
        reasoning: 80, coding: 78, multilingual: 90, speed: 90,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
    {
      id: "glm-4v-flash",
      displayName: "GLM-4V Flash",
      capabilities: {
        // Vision but no tools, and a much smaller window — declaring the window
        // honestly is what stops the router sending a long conversation here.
        streaming: true, vision: true,
        contextWindow: 8_000, maxOutputTokens: 2048,
        reasoning: 78, coding: 62, multilingual: 86, speed: 84,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({
      ...config,
      baseURL: config.settings?.baseURL ?? "https://open.bigmodel.cn/api/paas/v4",
      embeddingModel: "embedding-3",
    });
  }
}
