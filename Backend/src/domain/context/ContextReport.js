/**
 * What the context engine did, and why.
 *
 * **This is the product of the whole context engine.** An engine that trims
 * without reporting is one whose behaviour nobody can explain — including the
 * people who wrote it. Silent trimming is the single most confusing failure mode
 * in a chat product: the model "forgets" something the user can still see on
 * screen (docs/backend/06-context-engine.md#the-context-report).
 *
 * It is four things at once:
 *   - **logged** with the request, so a bad answer traces to the exact context
 *   - **surfaced** to the user when meaningful ("earlier messages were summarised")
 *   - **asserted in tests** — trimming tests check the report, not just the
 *     window, which is what makes the invariants enforceable
 *   - **the metric source** for compression rate, trim frequency, estimation error
 */
export class ContextReport {
  constructor({ targetModel, budget }) {
    this.targetModel = targetModel;
    this.budget = budget;

    this.estimatedTokens = 0;
    this.correctionFactor = 1;

    this.included = {
      systemPrompt: 0,
      memory: 0,
      documents: 0,
      summaries: 0,
      pinned: 0,
      messages: 0,
    };

    /** @type {Array<{messageId, reason, tokensSaved}>} */
    this.trimmed = [];
    /** @type {Array<{fromIndex, toIndex, originalTokens, summaryTokens}>} */
    this.compressed = [];
    /** @type {Array<{messageId, tokensOmitted}>} */
    this.truncated = [];
    /** @type {string[]} */
    this.warnings = [];
    /** Which trimming stages actually ran, in order. */
    this.stagesApplied = [];
  }

  recordTrimmed(messageId, reason, tokensSaved) {
    this.trimmed.push({ messageId, reason, tokensSaved });
  }

  recordCompressed(fromIndex, toIndex, originalTokens, summaryTokens) {
    this.compressed.push({ fromIndex, toIndex, originalTokens, summaryTokens });
  }

  recordTruncated(messageId, tokensOmitted) {
    this.truncated.push({ messageId, tokensOmitted });
  }

  recordStage(stage, tokensSaved) {
    this.stagesApplied.push({ stage, tokensSaved });
  }

  warn(message) {
    this.warnings.push(message);
  }

  /** True when the user should be told something was lost. */
  get isLossy() {
    return this.trimmed.length > 0 || this.truncated.length > 0 || this.compressed.length > 0;
  }

  get tokensSaved() {
    return (
      this.trimmed.reduce((s, t) => s + t.tokensSaved, 0) +
      this.truncated.reduce((s, t) => s + t.tokensOmitted, 0) +
      this.compressed.reduce((s, c) => s + (c.originalTokens - c.summaryTokens), 0)
    );
  }

  /** Fraction of the budget actually used. Feeds context-utilisation metrics. */
  get utilisation() {
    return this.budget.promptBudget > 0 ? this.estimatedTokens / this.budget.promptBudget : 0;
  }

  /**
   * One sentence for the user, or null when nothing was lost.
   *
   * Deliberately vague about counts: "3 of your earlier messages were removed"
   * invites a support question, while naming the *kind* of loss lets the user
   * decide whether to care.
   */
  userSummary() {
    if (!this.isLossy) return null;
    const parts = [];
    if (this.compressed.length) parts.push("earlier messages were summarised");
    if (this.trimmed.length) parts.push("some earlier messages were removed");
    if (this.truncated.length) parts.push("a long message was shortened");
    return `To fit this model's context window, ${parts.join(" and ")}.`;
  }

  toJSON() {
    return {
      targetModel: this.targetModel,
      budget: this.budget.toJSON(),
      estimatedTokens: this.estimatedTokens,
      correctionFactor: this.correctionFactor,
      utilisation: Number(this.utilisation.toFixed(3)),
      included: { ...this.included },
      stagesApplied: this.stagesApplied,
      trimmed: this.trimmed,
      compressed: this.compressed,
      truncated: this.truncated,
      warnings: this.warnings,
    };
  }
}
