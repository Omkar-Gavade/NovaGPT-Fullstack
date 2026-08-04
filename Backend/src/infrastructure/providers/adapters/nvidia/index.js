import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * NVIDIA NIM — free evaluation access to a broad catalog of open models.
 *
 * Useful capability diversity, but an evaluation tier (~40 req/min), so it is
 * not for production volume. Ranked accordingly by its speed score rather than
 * by a special case anywhere in the router.
 */
export const descriptor = {
  id: "nvidia",
  name: "NVIDIA NIM",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  models: [
    {
      id: "meta/llama-3.3-70b-instruct",
      displayName: "Llama 3.3 70B (NVIDIA)",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 80, coding: 78, multilingual: 70, speed: 82,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
    {
      id: "qwen/qwen2.5-coder-32b-instruct",
      displayName: "Qwen2.5 Coder 32B",
      capabilities: {
        streaming: true, json: true,
        contextWindow: 32_000, maxOutputTokens: 8192,
        reasoning: 78, coding: 90, multilingual: 74, speed: 80,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({ ...config, baseURL: config.settings?.baseURL ?? "https://integrate.api.nvidia.com/v1" });
  }
}
