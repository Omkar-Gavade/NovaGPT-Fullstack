import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class MistralProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "mistral",
      name: "Mistral",
      apiKey: process.env.MISTRAL_API_KEY,
      baseURL: "https://api.mistral.ai/v1",
      embeddingModel: "mistral-embed",
      models: modelsFor("mistral"),
    });
  }
}
