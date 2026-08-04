import { TokenBudget } from "./TokenBudget.js";
import { ContextReport } from "./ContextReport.js";
import { TrimmingPipeline } from "./TrimmingPipeline.js";
import { MemoryInjection } from "./MemoryInjection.js";
import { CalibratedTokenEstimator } from "./TokenEstimator.js";
import { ExtractiveSummarizer } from "./Summarizer.js";
import { truncateToFit } from "./Truncation.js";

/**
 * Turns a stored conversation into a bounded prompt.
 *
 * The component that decides what the model gets to see. Every quality
 * complaint that is not a model complaint is a context complaint: the model
 * "forgot" something, "ignored" an instruction, or "lost the thread". Those are
 * outcomes of this class (docs/backend/06-context-engine.md).
 *
 * Three properties it holds, in order of importance:
 *
 *   **Deterministic.** Same conversation, same budget, same model → a
 *   byte-identical prompt. Without this, a quality regression is unreproducible
 *   and a user's bug report is unactionable.
 *
 *   **Explicit.** Every trim, compression and injection appears in the
 *   `ContextReport`. Silent context loss is the failure mode this whole design
 *   exists to prevent.
 *
 *   **Pure.** No database, no network, no clock. "What happens to a 200-message
 *   thread at a 128K budget?" is a unit test, not an integration test.
 *
 * Model-aware, provider-agnostic: it budgets against the target *model's*
 * window and knows nothing about who serves it.
 */
export class ContextEngine {
  /**
   * @param {object} [deps]
   * @param {import("./TokenEstimator.js").TokenEstimator} [deps.estimator]
   * @param {import("./Summarizer.js").SummarizerPort} [deps.summarizer]
   */
  constructor({ estimator, summarizer } = {}) {
    this.estimator = estimator ?? new CalibratedTokenEstimator();
    this.summarizer = summarizer ?? new ExtractiveSummarizer();
    this.memory = new MemoryInjection({ estimator: this.estimator });
    this.pipeline = new TrimmingPipeline({
      estimator: this.estimator,
      summarizer: this.summarizer,
    });
  }

  /**
   * @param {object} input
   * @param {import("../capability/ModelDescriptor.js").ModelDescriptor} input.model
   * @param {object[]} [input.history]      chronological, excluding the newest
   * @param {object} input.newest           the message being answered
   * @param {string} [input.systemPrompt]
   * @param {string} [input.profile]
   * @param {string[]} [input.longTerm]
   * @param {object[]} [input.documents]
   * @param {number} [input.maxTokens]      requested output length
   * @returns {{messages: object[], report: ContextReport}}
   */
  assemble({
    model,
    history = [],
    newest,
    systemPrompt = "",
    profile,
    longTerm = [],
    documents = [],
    maxTokens = 2048,
  }) {
    if (!newest) throw new TypeError("ContextEngine.assemble needs the newest message");

    // The system prompt is measured before the budget is built, because it is
    // subtracted from the window rather than competing for what remains.
    const systemPromptTokens = systemPrompt?.trim()
      ? this.estimator.estimateText(systemPrompt.trim()) + this.estimator.perMessageOverhead
      : 0;

    const budget = TokenBudget.forModel(model, { maxTokens, systemPromptTokens, maxOutputTokens: maxTokens });
    const report = new ContextReport({ targetModel: model.id, budget });
    report.correctionFactor = this.estimator.correctionFactor ?? 1;

    /* ---- 1. Leading, stable content ---------------------------------- */
    const { messages: leading, tokens: fixedTokens } = this.memory.build({
      systemPrompt,
      profile,
      longTerm,
      documents,
      budget,
      report,
    });

    /* ---- 2. Pinned messages, capped ---------------------------------- */
    // Honoured newest-first up to the cap rather than silently ignored: beyond
    // it, pinned content would crowd out the recent conversation.
    const { pinned, rest } = this.#partitionPinned(history, budget, report);

    /* ---- 3. Trim what remains to fit --------------------------------- */
    const trimmed = this.pipeline.run({
      messages: rest,
      newest,
      pinned,
      budget,
      fixedTokens,
      report,
    });

    /* ---- 4. Assemble in injection order ------------------------------ */
    const summaries = trimmed.filter((m) => m.isSummary);
    const conversation = trimmed.filter((m) => !m.isSummary);

    const messages = [
      ...leading,
      ...summaries, // stable-ish: changes only when compression runs
      ...pinned,
      ...conversation,
      newest,
    ].map(toWireMessage);

    report.included.summaries = this.estimator.estimateMessages(summaries);
    report.included.pinned = this.estimator.estimateMessages(pinned);
    report.included.messages = this.estimator.estimateMessages(conversation);
    report.estimatedTokens =
      fixedTokens +
      report.included.summaries +
      report.included.pinned +
      report.included.messages +
      this.estimator.estimateMessage(newest);

    if (report.utilisation > 0.95) {
      report.warn("context is within 5% of the prompt budget; the next turn will trim");
    }

    return { messages, report };
  }

  /**
   * Should compression run before the next turn?
   *
   * Proactive at 70%, not reactive at overflow: compressing at the moment of
   * overflow puts work in the user's critical path, while at 70% it runs
   * between turns and the user never waits for it.
   */
  shouldCompress({ model, history, maxTokens = 2048, systemPrompt = "" }) {
    const systemPromptTokens = systemPrompt?.trim()
      ? this.estimator.estimateText(systemPrompt.trim())
      : 0;
    const budget = TokenBudget.forModel(model, { maxOutputTokens: maxTokens, systemPromptTokens });
    return this.estimator.estimateMessages(history) >= budget.compressionThreshold;
  }

  /** Feed a provider's reported usage back into the estimator. */
  calibrate(estimatedPromptTokens, actualPromptTokens) {
    return this.estimator.calibrate?.(estimatedPromptTokens, actualPromptTokens) ?? 1;
  }

  /**
   * Statistics for a conversation, without assembling it.
   * Used by diagnostics and by the UI's "this conversation is getting long" hint.
   */
  statistics({ model, history = [], maxTokens = 2048 }) {
    const budget = TokenBudget.forModel(model, { maxOutputTokens: maxTokens });
    const tokens = this.estimator.estimateMessages(history);
    return {
      messageCount: history.length,
      estimatedTokens: tokens,
      promptBudget: budget.promptBudget,
      utilisation: budget.promptBudget > 0 ? tokens / budget.promptBudget : 0,
      willCompress: tokens >= budget.compressionThreshold,
      willTrim: tokens > budget.promptBudget,
      pinnedCount: history.filter((m) => m.pinned).length,
      summaryCount: history.filter((m) => m.isSummary).length,
    };
  }

  /**
   * Split pinned messages out, capped at 40% of the budget.
   *
   * Pins are a *user* control because relevance is not inferable from text: a
   * user who pastes a schema on turn 3 and asks about it on turn 40 knows it is
   * load-bearing, and no recency or similarity heuristic reliably does.
   */
  #partitionPinned(history, budget, report) {
    const rest = [];
    let pinnedTokens = 0;

    // Newest-first for the cap decision, so the most recent pins keep their
    // full text and older ones absorb the shortening.
    const candidates = history.filter((m) => m.pinned);
    /** @type {Map<object, object>} original -> what will actually be sent */
    const kept = new Map();

    for (const message of [...candidates].reverse()) {
      const tokens = this.estimator.estimateMessage(message);
      const remaining = budget.pinnedBudget - pinnedTokens;

      if (tokens <= remaining) {
        pinnedTokens += tokens;
        kept.set(message, message);
        continue;
      }

      // A pinned message over the cap is truncated, never dropped. The user
      // explicitly marked it as required context, and "pinned messages are
      // always present" is a documented invariant — dropping it silently
      // removes the one thing they asked to keep
      // (docs/backend/06-context-engine.md#the-invariants).
      const truncated = truncateToFit(message, remaining, this.estimator);
      if (truncated) {
        pinnedTokens += this.estimator.estimateMessage(truncated.message);
        kept.set(message, truncated.message);
        report.recordTruncated(message.id ?? "(pinned)", truncated.omittedTokens);
        report.warn(
          `a pinned message was shortened: pinned content is capped at ${budget.pinnedBudget} tokens (40% of the prompt budget)`
        );
      } else {
        // Only when there is not even room for a usefully truncated fragment.
        report.recordTrimmed(
          message.id ?? "(pinned)",
          "pinned message could not fit even truncated",
          this.estimator.estimateMessage(message)
        );
        report.warn("a pinned message could not be included: no room remained even after shortening");
      }
    }

    // Re-emitted in chronological order — reordering destroys causal structure.
    const pinned = [];
    for (const message of history) {
      if (kept.has(message)) pinned.push(kept.get(message));
      else if (!message.pinned) rest.push(message);
    }

    return { pinned, rest };
  }
}

/** Strip internal bookkeeping so adapters receive only role and content. */
function toWireMessage(message) {
  return typeof message.content === "string" || Array.isArray(message.content)
    ? { role: message.role, content: message.content }
    : { role: message.role, content: String(message.content ?? "") };
}
