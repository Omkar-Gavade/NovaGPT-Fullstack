/**
 * Per-model pricing, for measured cost accounting.
 *
 * Distinct from the `costBand` used in ranking, and the distinction is
 * deliberate (docs/backend/04-router.md#ranking):
 *
 *   **`costBand`** is coarse (`Free`/`$`/`$$`/`$$$`), stable, and used to
 *   *order* candidates. Exact prices change constantly across eight providers
 *   and would need continuous maintenance to stay accurate, so ranking must not
 *   depend on them.
 *
 *   **This table** is exact, versioned by effective date, and used to *account*
 *   for spend after the fact — where being wrong is a reporting error rather
 *   than a routing error (docs/backend/11-observability.md#cost-monitoring).
 *
 * Prices are USD per million tokens. Entries carry an `effectiveFrom` so a
 * historical usage record is costed at the price that applied when it was
 * incurred, rather than being retroactively rewritten by a price change.
 *
 * Lives in `infrastructure/providers/catalog/` alongside the model catalog, for
 * the same reason: it is provider-specific *data*, not domain logic. Keeping
 * model ids out of `domain/` is what lets the domain stay honestly
 * provider-agnostic (docs/backend/16-repository-structure.md).
 */

export const PRICES = Object.freeze([
  // Gemini
  { model: "gemini-2.5-flash", input: 0.3, output: 2.5, effectiveFrom: "2026-01-01" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.0, effectiveFrom: "2026-01-01" },
  { model: "text-embedding-004", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },

  // Groq — free developer tier
  { model: "llama-3.3-70b-versatile", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
  { model: "llama-3.1-8b-instant", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
  { model: "openai/gpt-oss-120b", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },

  // DeepSeek
  { model: "deepseek-chat", input: 0.27, output: 1.1, effectiveFrom: "2026-01-01" },
  { model: "deepseek-reasoner", input: 0.55, output: 2.19, effectiveFrom: "2026-01-01" },

  // Qwen
  { model: "qwen-plus", input: 0.4, output: 1.2, effectiveFrom: "2026-01-01" },
  { model: "qwen-turbo", input: 0.05, output: 0.2, effectiveFrom: "2026-01-01" },

  // Mistral
  { model: "mistral-large-latest", input: 2.0, output: 6.0, effectiveFrom: "2026-01-01" },
  { model: "open-mistral-nemo", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },

  // OpenRouter free pool
  { model: "meta-llama/llama-3.3-70b-instruct:free", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
  { model: "google/gemma-3-27b-it:free", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },

  // GLM
  { model: "glm-4-flash", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
  { model: "glm-4v-flash", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },

  // NVIDIA NIM — free evaluation
  { model: "meta/llama-3.3-70b-instruct", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
  { model: "qwen/qwen2.5-coder-32b-instruct", input: 0.0, output: 0.0, effectiveFrom: "2026-01-01" },
]);

const PER_MILLION = 1_000_000;

export class CostTable {
  constructor(prices = PRICES) {
    /** @type {Map<string, object[]>} newest-first per model */
    this.byModel = new Map();
    for (const entry of prices) {
      const list = this.byModel.get(entry.model) ?? [];
      list.push(entry);
      this.byModel.set(entry.model, list);
    }
    for (const list of this.byModel.values()) {
      list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    }
  }

  /** The price in force on `at`, or null when the model is unpriced. */
  priceFor(modelId, at = new Date().toISOString()) {
    const list = this.byModel.get(modelId);
    if (!list) return null;
    return list.find((entry) => entry.effectiveFrom <= at) ?? null;
  }

  /**
   * Cost in USD for measured token counts.
   *
   * Computed from what the provider actually reported, never estimated from
   * request counts: usage varies by orders of magnitude per request, so a
   * per-request estimate is not an approximation but a fiction.
   *
   * Returns `0` for a free tier and `null` for an unknown model — the two are
   * different, and collapsing them would silently understate spend when a new
   * model is added without a price.
   */
  costFor({ modelId, promptTokens = 0, completionTokens = 0, at }) {
    const price = this.priceFor(modelId, at);
    if (!price) return null;
    return (
      (promptTokens * price.input) / PER_MILLION +
      (completionTokens * price.output) / PER_MILLION
    );
  }

  /** Models with no price entry. Feeds the quarterly catalog audit. */
  unpriced(modelIds) {
    return modelIds.filter((id) => !this.byModel.has(id));
  }
}

export const costTable = new CostTable();
