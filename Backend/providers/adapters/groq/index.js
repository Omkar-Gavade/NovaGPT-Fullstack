import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class GroqProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "groq",
      name: "Groq",
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      models: modelsFor("groq"),
    });
  }
}
