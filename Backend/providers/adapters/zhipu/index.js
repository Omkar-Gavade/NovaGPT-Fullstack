import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Zhipu AI (GLM) — GLM-4-Flash is free, OpenAI-compatible. */
export class ZhipuProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "zhipu",
      name: "Zhipu GLM",
      apiKey: process.env.ZHIPU_API_KEY,
      baseURL: process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
      models: modelsFor("zhipu"),
    });
  }
}
