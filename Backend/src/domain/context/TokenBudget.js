import { AppError, ErrorKind } from "../errors/index.js";

/**
 * How many prompt tokens this request may actually spend.
 *
 * The model's advertised window is **not** the prompt budget — four things share
 * it (docs/backend/06-context-engine.md#context-windows-and-budgeting):
 *
 *     promptBudget = contextWindow
 *                  - maxOutputTokens   // the reply must fit
 *                  - systemPromptTokens
 *                  - safetyMargin      // 10% of window, min 512, max 8000
 *
 * Pure arithmetic over a model descriptor. It is a class rather than a function
 * because the *components* are as useful as the total: a diagnostic that says
 * "the safety margin took 8,000 tokens" explains a surprising budget, and a bare
 * number does not.
 */

const SAFETY_MARGIN_RATIO = 0.1;
const SAFETY_MARGIN_MIN = 512;
const SAFETY_MARGIN_MAX = 8000;

/** Injected memory is capped so it cannot crowd out the conversation. */
const MEMORY_SHARE = 0.25;

/** Pinned content is capped for the same reason, but more generously. */
const PINNED_SHARE = 0.4;

/** Most of the post-margin window one reply may reserve. */
const OUTPUT_RESERVE_CAP = 0.5;

export class TokenBudget {
  /**
   * @param {object} input
   * @param {number} input.contextWindow
   * @param {number} input.maxOutputTokens  what the caller asked the model to generate
   * @param {number} [input.systemPromptTokens]
   * @param {number} [input.modelMaxOutputTokens] the model's own output ceiling
   */
  constructor({ contextWindow, maxOutputTokens, systemPromptTokens = 0, modelMaxOutputTokens }) {
    if (!(contextWindow > 0)) {
      throw new TypeError("TokenBudget needs a positive contextWindow");
    }

    this.contextWindow = contextWindow;

    // A caller asking for more output than the model can produce would silently
    // over-reserve, shrinking the prompt budget for tokens that can never be
    // generated.
    const requested = Math.min(
      Math.max(0, maxOutputTokens ?? 0),
      modelMaxOutputTokens ?? maxOutputTokens ?? 0
    );

    this.systemPromptTokens = Math.max(0, systemPromptTokens);

    // Percentage-based because estimation error scales with content length: a
    // fixed margin is wastefully large for an 8K window and dangerously small
    // for a 1M one. Capped so a huge window does not squander 100K on margin.
    this.safetyMargin = clamp(
      Math.ceil(contextWindow * SAFETY_MARGIN_RATIO),
      SAFETY_MARGIN_MIN,
      SAFETY_MARGIN_MAX
    );

    // The output reservation is itself capped, so a small window cannot be
    // consumed entirely by a default `maxTokens`. Asking for 2,048 output
    // tokens from a 2,500-token window leaves nothing for a prompt, and the
    // resulting zero budget makes *every* request fail with "too large" — a
    // configuration mistake presenting as a user error. Half of what remains
    // after the margin is the most any reply may reserve.
    const reservable = Math.max(0, contextWindow - this.systemPromptTokens - this.safetyMargin);
    this.maxOutputTokens = Math.min(requested, Math.floor(reservable * OUTPUT_RESERVE_CAP));
    this.requestedOutputTokens = requested;
    this.outputWasClamped = this.maxOutputTokens < requested;

    this.promptBudget = Math.max(
      0,
      this.contextWindow - this.maxOutputTokens - this.systemPromptTokens - this.safetyMargin
    );

    Object.freeze(this);
  }

  /**
   * Build a budget from a model descriptor.
   * The only place model shape meets budget arithmetic, so nothing downstream
   * needs to know how a window is declared.
   */
  static forModel(model, { maxOutputTokens, systemPromptTokens = 0 } = {}) {
    const contextWindow = model?.capabilities?.value("contextWindow");
    if (!(contextWindow > 0)) {
      throw new AppError(
        `Model ${model?.id ?? "(unknown)"} does not declare a context window.`,
        ErrorKind.INTERNAL,
        { details: { modelId: model?.id } }
      );
    }
    return new TokenBudget({
      contextWindow,
      maxOutputTokens: maxOutputTokens ?? 2048,
      systemPromptTokens,
      modelMaxOutputTokens: model.capabilities.value("maxOutputTokens") ?? undefined,
    });
  }

  /** Ceiling for injected memory — profile, long-term memory, retrieved docs. */
  get memoryBudget() {
    return Math.floor(this.promptBudget * MEMORY_SHARE);
  }

  /**
   * Ceiling for pinned messages.
   *
   * Pins are honoured newest-first up to this cap rather than silently ignored:
   * beyond it, pinned content would crowd out the recent conversation and the
   * model would answer from stale context.
   */
  get pinnedBudget() {
    return Math.floor(this.promptBudget * PINNED_SHARE);
  }

  /**
   * Compression runs proactively at this level, not at overflow.
   *
   * Compressing at the moment of overflow puts a model call in the user's
   * critical path. At 70% it runs between turns, so the user never waits for it
   * (docs/backend/06-context-engine.md#trigger).
   */
  get compressionThreshold() {
    return Math.floor(this.promptBudget * 0.7);
  }

  fits(tokens) {
    return tokens <= this.promptBudget;
  }

  remaining(tokens) {
    return this.promptBudget - tokens;
  }

  toJSON() {
    return {
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      systemPromptTokens: this.systemPromptTokens,
      safetyMargin: this.safetyMargin,
      promptBudget: this.promptBudget,
      ...(this.outputWasClamped ? { requestedOutputTokens: this.requestedOutputTokens } : {}),
    };
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
