import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** GitHub Models — free, OpenAI-compatible (Azure-hosted); auth with a GitHub PAT. */
export class GitHubModelsProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "github",
      name: "GitHub Models",
      apiKey: process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN,
      baseURL: process.env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference",
      models: modelsFor("github"),
    });
  }
}
