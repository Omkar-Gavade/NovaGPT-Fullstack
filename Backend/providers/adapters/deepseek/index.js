import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "deepseek",
      name: "DeepSeek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com/v1",
      models: modelsFor("deepseek"),
    });
  }
}
