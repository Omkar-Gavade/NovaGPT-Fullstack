import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Cohere — trial API key (~100 req/day), via its OpenAI-compatibility endpoint. */
export class CohereProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "cohere",
      name: "Cohere",
      apiKey: process.env.COHERE_API_KEY,
      baseURL: process.env.COHERE_BASE_URL || "https://api.cohere.ai/compatibility/v1",
      models: modelsFor("cohere"),
    });
  }
}
