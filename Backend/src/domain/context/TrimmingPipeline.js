import { AppError, ErrorKind } from "../errors/index.js";

/**
 * The five-stage trimming pipeline.
 *
 * Stages run in a **fixed order**, cheapest-loss first, and stop as soon as the
 * window fits (docs/backend/06-context-engine.md#history-trimming):
 *
 *   1. Drop tool artefacts — highest token-per-value content in a conversation
 *   2. Compress the oldest unsummarised span — preserves substance, not detail
 *   3. Drop whole turn pairs, oldest first — loses meaning, but stays coherent
 *   4. Truncate the middle of one oversized message — last resort within a turn
 *   5. Fail loudly — nothing left to trim
 *
 * The order is the design. Running (3) before (2) would delete history that
 * could have been summarised; running (4) before (3) would mangle a message
 * while whole redundant turns remain.
 *
 * Pure and deterministic: same conversation, same budget, byte-identical result.
 */

/** Turns kept verbatim, never compressed — the request is usually about them. */
const PRESERVE_RECENT_TURNS = 6;

/** Tool artefacts older than this many turns are the first thing dropped. */
const TOOL_ARTEFACT_AGE = 2;

/** Below this, compressing costs more than it saves. */
const MIN_COMPRESSION_SAVING = 200;

export class TrimmingPipeline {
  /**
   * @param {object} deps
   * @param {import("./TokenEstimator.js").TokenEstimator} deps.estimator
   * @param {import("./Summarizer.js").SummarizerPort} deps.summarizer
   */
  constructor({ estimator, summarizer }) {
    this.estimator = estimator;
    this.summarizer = summarizer;
  }

  /**
   * @param {object} input
   * @param {object[]} input.messages   history, chronological, excluding the newest
   * @param {object} input.newest       the message being answered — never dropped
   * @param {object[]} [input.pinned]   never dropped
   * @param {import("./TokenBudget.js").TokenBudget} input.budget
   * @param {number} input.fixedTokens  system prompt + memory + documents
   * @param {import("./ContextReport.js").ContextReport} input.report
   * @returns {object[]} the surviving history
   */
  run({ messages, newest, pinned = [], budget, fixedTokens, report }) {
    let working = [...messages];

    // A pure function of a message list, so a stage's saving is measured from
    // its own output rather than from mutable state the stage has not yet
    // been assigned back into.
    const totalFor = (list) =>
      fixedTokens +
      this.estimator.estimateMessages(pinned) +
      this.estimator.estimateMessages(list) +
      this.estimator.estimateMessage(newest);

    const fits = (list) => totalFor(list) <= budget.promptBudget;

    if (fits(working)) return working;

    /* ---- Stage 1: tool artefacts ------------------------------------- */
    // A search result can be thousands of tokens whose conclusion is already
    // restated in the assistant's reply. Least meaning lost per token recovered.
    working = this.#stage(report, "drop-tool-artefacts", working, totalFor, (list) =>
      this.#dropToolArtefacts(list, report)
    );
    if (fits(working)) return working;

    /* ---- Stage 2: compress ------------------------------------------- */
    // Preserves the substance of old turns; dropping loses it entirely.
    working = this.#stage(report, "compress", working, totalFor, (list) =>
      this.#compressOldest(list, report)
    );
    if (fits(working)) return working;

    /* ---- Stage 3: drop whole turn pairs ------------------------------ */
    working = this.#stage(report, "drop-turns", working, totalFor, (list) =>
      this.#dropOldestTurns(list, budget, fixedTokens, pinned, newest, report)
    );
    if (fits(working)) return working;

    /* ---- Stage 4: truncate the largest survivor ---------------------- */
    working = this.#stage(report, "truncate", working, totalFor, (list) =>
      this.#truncateLargest(list, budget, fixedTokens, pinned, newest, report)
    );
    if (fits(working)) return working;

    /* ---- Stage 5: fail loudly ---------------------------------------- */
    throw this.#irreducible({ budget, fixedTokens, pinned, newest, report });
  }

  /** Run one stage and record what it saved, so the report explains the path taken. */
  #stage(report, name, input, totalFor, apply) {
    const before = totalFor(input);
    const result = apply(input);
    report.recordStage(name, before - totalFor(result));
    return result;
  }

  /**
   * Stage 1 — remove tool calls and their results beyond the recent window.
   *
   * Recent tool artefacts stay: the current question is often *about* what a
   * tool just returned.
   */
  #dropToolArtefacts(messages, report) {
    const cutoff = messages.length - TOOL_ARTEFACT_AGE * 2;
    return messages.filter((message, index) => {
      const isArtefact = message.role === "tool" || Boolean(message.toolCalls?.length);
      if (!isArtefact || index >= cutoff) return true;
      report.recordTrimmed(
        message.id ?? `#${index}`,
        "tool artefact beyond the recent window",
        this.estimator.estimateMessage(message)
      );
      return false;
    });
  }

  /**
   * Stage 2 — replace the oldest unsummarised span with one summary.
   *
   * The most recent turns are left verbatim: they are what the current question
   * is about, and summarising them loses the exact wording, code and numbers the
   * model needs to answer.
   *
   * Summaries are produced from **originals only**, never from other summaries —
   * compounding a lossy transform is how detail disappears entirely.
   */
  #compressOldest(messages, report) {
    const preserveFrom = Math.max(0, messages.length - PRESERVE_RECENT_TURNS * 2);
    const span = messages.slice(0, preserveFrom).filter((m) => !m.isSummary);
    if (span.length < 2) return messages;

    const originalTokens = this.estimator.estimateMessages(span);
    const summary = this.summarizer.summarize(span, { fromIndex: 0, toIndex: preserveFrom - 1 });
    const summaryTokens = this.estimator.estimateMessage(summary);

    // Skip when the transform is not worth its own cost.
    if (originalTokens - summaryTokens < MIN_COMPRESSION_SAVING) return messages;

    report.recordCompressed(0, preserveFrom - 1, originalTokens, summaryTokens);

    const existingSummaries = messages.slice(0, preserveFrom).filter((m) => m.isSummary);
    return [...existingSummaries, summary, ...messages.slice(preserveFrom)];
  }

  /**
   * Stage 3 — drop the oldest turns until it fits.
   *
   * Turn *pairs*, never halves. An orphaned assistant reply reads as the model
   * answering a question nobody asked, and models trained on well-formed
   * dialogue behave badly on malformed history.
   */
  #dropOldestTurns(messages, budget, fixedTokens, pinned, newest, report) {
    const working = [...messages];
    const fits = () =>
      fixedTokens +
      this.estimator.estimateMessages(pinned) +
      this.estimator.estimateMessages(working) +
      this.estimator.estimateMessage(newest) <=
      budget.promptBudget;

    while (!fits() && working.length > 0) {
      const removed = [working.shift()];
      // Take the assistant reply that belongs to the user message just removed.
      if (working[0] && working[0].role === "assistant" && removed[0].role === "user") {
        removed.push(working.shift());
      }
      for (const message of removed) {
        report.recordTrimmed(
          message.id ?? "(unidentified)",
          "oldest turn, dropped to fit the window",
          this.estimator.estimateMessage(message)
        );
      }
    }
    return working;
  }

  /**
   * Stage 4 — cut the middle out of the single largest message.
   *
   * The beginning carries the setup and the end carries the conclusion; the
   * middle is the most compressible region. The marker is **mandatory** — an
   * unmarked truncation makes the model confidently reason about content it
   * never received.
   */
  #truncateLargest(messages, budget, fixedTokens, pinned, newest, report) {
    // Pinned messages are candidates here even though they survive stage 3:
    // they cannot be dropped, so an oversized pinned message is precisely the
    // case this stage exists for. Mutating in place keeps the pinned array the
    // caller holds consistent with what was measured.
    const candidates = messages.length > 0 ? messages : pinned;
    if (candidates.length === 0) return messages;

    let largestIndex = 0;
    let largestTokens = 0;
    candidates.forEach((message, index) => {
      const tokens = this.estimator.estimateMessage(message);
      if (tokens > largestTokens) {
        largestTokens = tokens;
        largestIndex = index;
      }
    });

    const overBy =
      fixedTokens +
      this.estimator.estimateMessages(pinned) +
      this.estimator.estimateMessages(messages) +
      this.estimator.estimateMessage(newest) -
      budget.promptBudget;

    const target = candidates[largestIndex];
    const content = typeof target.content === "string" ? target.content : "";
    if (content.length === 0) return messages;

    // Convert the token overage back into characters, with headroom so one pass
    // is enough rather than looping.
    const charsToRemove = Math.min(
      content.length - 100,
      Math.ceil(overBy * 3.6 * 1.2)
    );
    if (charsToRemove <= 0) return messages;

    const keepEachSide = Math.floor((content.length - charsToRemove) / 2);
    if (keepEachSide < 50) return messages;

    const omittedTokens = this.estimator.estimateText(
      content.slice(keepEachSide, content.length - keepEachSide)
    );
    const truncated = {
      ...target,
      content: `${content.slice(0, keepEachSide)}\n\n[... ${omittedTokens.toLocaleString()} tokens omitted ...]\n\n${content.slice(content.length - keepEachSide)}`,
      tokenEstimate: undefined,
      wasTruncated: true,
    };

    report.recordTruncated(target.id ?? `#${largestIndex}`, omittedTokens);

    if (candidates === pinned) {
      // Pinned is the caller's array; replacing the entry in place keeps the
      // assembled prompt and the measured total in agreement.
      pinned[largestIndex] = truncated;
      return messages;
    }
    const out = [...messages];
    out[largestIndex] = truncated;
    return out;
  }

  /**
   * Stage 5 — nothing left to remove.
   *
   * The error names what is too large and which model would fit, because a
   * generic "context too long" leaves the user with no move to make
   * (docs/backend/05-capability-matrix.md#errors-the-matrix-makes-possible).
   */
  #irreducible({ budget, fixedTokens, pinned, newest, report }) {
    const newestTokens = this.estimator.estimateMessage(newest);
    const pinnedTokens = this.estimator.estimateMessages(pinned);
    const required = fixedTokens + pinnedTokens + newestTokens;

    report.warn("context could not be reduced to fit the budget");

    const culprit =
      newestTokens > budget.promptBudget
        ? "your message alone"
        : pinnedTokens > budget.pinnedBudget
        ? "the pinned messages"
        : "the system prompt and required content";

    return new AppError(
      `This request is too large for ${report.targetModel}: ${culprit} needs about ${required.toLocaleString()} tokens but only ${budget.promptBudget.toLocaleString()} are available. Try a model with a larger context window, unpin some messages, or shorten your message.`,
      ErrorKind.PAYLOAD_TOO_LARGE,
      {
        details: {
          model: report.targetModel,
          requiredTokens: required,
          availableTokens: budget.promptBudget,
          newestMessageTokens: newestTokens,
          pinnedTokens,
          fixedTokens,
        },
      }
    );
  }
}
