import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * Ollama — local inference.
 *
 * The one provider in the fleet that is **enabled by reachability rather than
 * by a credential**. Everything else follows the rule "a provider is enabled by
 * having a key"; a local runtime has no key to have, so `requiresCredentials`
 * is false and `OLLAMA_BASE_URL` doubles as the enable switch. Setting it is
 * the deliberate act that says "there is an Ollama here".
 *
 * **Why it earns its place in the fleet, rather than adding only redundancy**
 * (docs/backend/03-provider-system.md#provider-onboarding-process, step 1):
 *
 *   - **A failure-independence axis nothing else has.** Every other provider
 *     shares a single point of failure — the machine's internet connection.
 *     Ollama keeps working when the network does not, which makes it the only
 *     candidate that can serve a request during a total upstream outage.
 *   - **A privacy axis.** Prompts never leave the host. For a deployment that
 *     cannot send conversation content to a third party, this is the difference
 *     between using the product and not.
 *   - **Zero marginal quota.** It cannot exhaust a free tier, so it is the
 *     natural last resort when every hosted provider has.
 *
 * **The models are declared as a floor, not a promise.** Which models a given
 * Ollama has pulled is a property of that machine, not of this adapter, so the
 * catalog lists common defaults with conservative capability claims. A
 * deployment running something else should override the entries rather than
 * have the router assume a model that is not installed.
 *
 * Ships **dark**: it has never been verified against a running instance from
 * this repository, and a local model's speed and quality vary by two orders of
 * magnitude with the host's hardware — which is exactly the kind of unknown
 * ranking should learn from telemetry rather than from a guessed score.
 */
export const descriptor = {
  id: "ollama",
  name: "Ollama (local)",
  dialect: "openai",
  adapterVersion: "1.0.0",
  // The base URL is the switch. Absent, the adapter is skipped exactly as an
  // unkeyed provider is.
  envKeys: ["OLLAMA_BASE_URL"],
  // No key exists to require. The factory's "configured" determination falls
  // through to the base URL check below.
  requiresCredentials: false,
  experimental: true,
  models: [
    {
      id: "llama3.1:8b",
      displayName: "Llama 3.1 8B (local)",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 4096,
        // Deliberately modest. A local 8B model on a laptop is slower and
        // weaker than any hosted frontier model, and an optimistic score here
        // would route real traffic to it before it has earned any.
        reasoning: 60, coding: 58, multilingual: 55, speed: 40,
      },
      // Free in the sense that matters here: it consumes no external quota.
      tier: "free", costBand: "Free", verifiedAt: null,
    },
    {
      id: "qwen2.5-coder:7b",
      displayName: "Qwen2.5 Coder 7B (local)",
      capabilities: {
        streaming: true, json: true,
        contextWindow: 32_000, maxOutputTokens: 4096,
        reasoning: 55, coding: 72, multilingual: 50, speed: 42,
      },
      tier: "free", costBand: "Free", verifiedAt: null,
    },
    {
      id: "nomic-embed-text",
      displayName: "Nomic Embed (local)",
      capabilities: { embeddings: true, contextWindow: 8_192, maxOutputTokens: 1 },
      tier: "free", costBand: "Free", verifiedAt: null,
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({
      ...config,
      // Ollama's OpenAI-compatible surface. The env var carries the host, and
      // the `/v1` suffix is appended here so an operator sets the same value
      // Ollama's own documentation shows.
      baseURL: normaliseBaseURL(config.settings?.baseURL),
      embeddingModel: "nomic-embed-text",
      settings: {
        // Local inference has no shared quota and no rate limit, but it does
        // have a queue: Ollama serves one generation at a time per model, so a
        // second request waits for the first. The 60s default is tuned for
        // hosted APIs and would time out a local model that was working
        // correctly, just slowly.
        //
        // Supplied as a *default* — an operator setting `timeoutMs` still wins,
        // which is why the spread comes second.
        timeoutMs: 300_000,
        ...config.settings,
      },
    });
  }
}

/**
 * Accepts what an operator would naturally paste.
 *
 * `http://localhost:11434`, with or without a trailing slash, with or without
 * the `/v1` Ollama's OpenAI-compatible API lives under. Getting this wrong
 * produces a 404 that reads like the model is missing.
 */
function normaliseBaseURL(value) {
  const base = String(value ?? "http://localhost:11434").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}
