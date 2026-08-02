import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** NVIDIA NIM — free evaluation tier (40 req/min), OpenAI-compatible. */
export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "nvidia",
      name: "NVIDIA NIM",
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
      models: modelsFor("nvidia"),
    });
  }
}
