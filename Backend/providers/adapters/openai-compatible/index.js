import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Any self-hosted / third-party endpoint that speaks the OpenAI dialect. */
export class OpenAICompatibleCustomProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "openai-compatible",
      name: "Custom endpoint",
      apiKey: process.env.CUSTOM_API_KEY,
      requiresKey: false,
      baseURL: process.env.CUSTOM_BASE_URL,
      models: modelsFor("openai-compatible"),
    });
  }

  get isConfigured() {
    return Boolean(this.baseURL);
  }
}
