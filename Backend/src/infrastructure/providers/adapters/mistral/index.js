import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * Mistral — European hosting, which is a hard requirement for some deployments,
 * plus a free experimental tier that may change without notice.
 */
export const descriptor = {
  id: "mistral",
  name: "Mistral",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["MISTRAL_API_KEY"],
  models: [
    {
      id: "mistral-large-latest",
      displayName: "Mistral Large",
      capabilities: {
        streaming: true, json: true, structuredOutput: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 85, coding: 84, multilingual: 82, speed: 86,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
    {
      id: "open-mistral-nemo",
      displayName: "Mistral Nemo",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 76, coding: 72, multilingual: 78, speed: 90,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({
      ...config,
      baseURL: config.settings?.baseURL ?? "https://api.mistral.ai/v1",
      embeddingModel: "mistral-embed",
    });
  }
}
