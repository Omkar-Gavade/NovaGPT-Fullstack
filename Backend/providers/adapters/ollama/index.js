import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/** Local Ollama — OpenAI-compatible surface, no API key. */
export class OllamaProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "ollama",
      name: "Ollama",
      requiresKey: false,
      baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      embeddingModel: "nomic-embed-text",
      models: modelsFor("ollama"),
      timeoutMs: 120_000,
    });
  }

  /** Ask the local daemon what's actually pulled. */
  async listModels() {
    try {
      const res = await fetch(`${this.baseURL}/models`, { headers: this.headers });
      if (!res.ok) return this.models;
      const data = await res.json();
      const local = (data.data || []).map((m) => ({
        id: m.id,
        provider: "ollama",
        name: `${m.id} (local)`,
        speed: 70,
        reasoning: 74,
        vision: false,
        tools: false,
        context: 128_000,
        tier: "free",
        cost: "Free",
      }));
      return local.length ? local : this.models;
    } catch {
      return this.models;
    }
  }
}
