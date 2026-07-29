import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "openai",
      name: "OpenAI",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      embeddingModel: "text-embedding-3-small",
      models: modelsFor("openai"),
    });
  }
}
