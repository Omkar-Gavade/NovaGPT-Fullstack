import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "openrouter",
      name: "OpenRouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      models: modelsFor("openrouter"),
    });
  }

  get headers() {
    return {
      ...super.headers,
      "HTTP-Referer": process.env.PUBLIC_URL || "http://localhost:5173",
      "X-Title": "NovaGPT",
    };
  }
}
