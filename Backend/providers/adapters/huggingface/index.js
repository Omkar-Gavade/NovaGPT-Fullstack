import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Hugging Face — free serverless inference router, OpenAI-compatible. */
export class HuggingFaceProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "huggingface",
      name: "Hugging Face",
      apiKey: process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY,
      baseURL: process.env.HF_BASE_URL || "https://router.huggingface.co/v1",
      models: modelsFor("huggingface"),
    });
  }
}
