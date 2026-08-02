import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Cerebras — wafer-scale inference, free ~1M tokens/day, OpenAI-compatible. */
export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "cerebras",
      name: "Cerebras",
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
      models: modelsFor("cerebras"),
    });
  }
}
