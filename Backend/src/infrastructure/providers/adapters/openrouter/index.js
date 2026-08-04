import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * OpenRouter — one key unlocking a rotating pool of `:free` models.
 *
 * The cheapest possible breadth, and a hedge against any single provider
 * disappearing. The free pool's membership changes, which is exactly why
 * `listModels()` live-probing matters more here than elsewhere: a catalog entry
 * whose upstream has rotated out is removed rather than routed to.
 */
export const descriptor = {
  id: "openrouter",
  name: "OpenRouter",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["OPENROUTER_API_KEY"],
  models: [
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      displayName: "Llama 3.3 70B (free)",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 80, coding: 78, multilingual: 72, speed: 74,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
    {
      id: "google/gemma-3-27b-it:free",
      displayName: "Gemma 3 27B (free)",
      capabilities: {
        streaming: true, json: true,
        contextWindow: 96_000, maxOutputTokens: 8192,
        reasoning: 72, coding: 70, multilingual: 76, speed: 80,
      },
      tier: "free", costBand: "Free", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({ ...config, baseURL: config.settings?.baseURL ?? "https://openrouter.ai/api/v1" });
  }

  /**
   * OpenRouter asks integrators to identify themselves. Attribution headers are
   * optional but affect free-tier rate limits, so they are worth sending.
   */
  get headers() {
    return {
      ...super.headers,
      "HTTP-Referer": this.settings.referer ?? "https://github.com/Omkar-Gavade/NovaGPT-Fullstack",
      "X-Title": this.settings.title ?? "NovaGPT",
    };
  }
}
