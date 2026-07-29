import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class KimiProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "kimi",
      name: "Kimi",
      apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY,
      baseURL: "https://api.moonshot.cn/v1",
      models: modelsFor("kimi"),
    });
  }
}
