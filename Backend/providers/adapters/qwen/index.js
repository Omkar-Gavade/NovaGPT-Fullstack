import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

export class QwenProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "qwen",
      name: "Qwen",
      apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY,
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      models: modelsFor("qwen"),
    });
  }
}
