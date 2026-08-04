/**
 * Token estimation, without a tokeniser.
 *
 * Exact tokenisation is impossible here: every provider uses a different
 * tokeniser, most do not publish theirs, and shipping eight would add tens of
 * megabytes of vocabulary to serve an estimate the safety margin already covers
 * (docs/backend/06-context-engine.md#token-estimation).
 *
 * **Estimates skew high, deliberately.** Underestimating means the provider
 * rejects the request after a full round trip — wasted latency, wasted quota, a
 * user-visible error. Overestimating means slightly more trimming than strictly
 * necessary, which nobody notices. The costs are asymmetric, so the heuristic is
 * too.
 *
 * Pure and deterministic: the same text always produces the same number, which
 * is what makes a trimming decision reproducible from a bug report.
 */

/**
 * Characters per token for English prose.
 *
 * Empirically between GPT-family (~4.0) and Llama-family (~3.5). Chosen at the
 * low end so estimates round upward — the safe direction.
 */
const CHARS_PER_TOKEN = 3.6;

/**
 * Every chat format wraps a message in role markers and delimiters that are
 * invisible in the content but real in the count.
 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Script weights, expressed as characters-worth per actual character.
 *
 * CJK is the important one: a Han character is roughly one token in every
 * tokeniser, not 3.6 characters' worth, so counting it as prose underestimates
 * by ~3.6× — enough to blow a budget on a Chinese conversation.
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const CJK_WEIGHT = CHARS_PER_TOKEN; // ~1 token per character

/**
 * Punctuation and symbols fragment badly: identifiers, operators and brackets
 * rarely merge into multi-character tokens the way prose does.
 */
const FRAGMENTING = /[^\p{L}\p{N}\s]/u;
const FRAGMENTING_WEIGHT = 1.6;

export class TokenEstimator {
  /**
   * @param {object} [options]
   * @param {number} [options.charsPerToken]
   * @param {number} [options.perMessageOverhead]
   */
  constructor({ charsPerToken = CHARS_PER_TOKEN, perMessageOverhead = PER_MESSAGE_OVERHEAD } = {}) {
    this.charsPerToken = charsPerToken;
    this.perMessageOverhead = perMessageOverhead;
  }

  /**
   * Estimate a plain string.
   *
   * Walks the text once, weighting each character by script. A regex-count
   * approach would need several passes and would double-count characters that
   * match more than one class.
   */
  estimateText(text) {
    if (typeof text !== "string" || text.length === 0) return 0;

    let weighted = 0;
    for (const char of text) {
      if (CJK.test(char)) weighted += CJK_WEIGHT;
      else if (FRAGMENTING.test(char)) weighted += FRAGMENTING_WEIGHT;
      else weighted += 1;
    }
    return Math.ceil(weighted / this.charsPerToken);
  }

  /**
   * Estimate one message, including its envelope.
   *
   * Non-string content (tool calls, image parts) is serialised before counting.
   * An image's *real* cost is provider-specific and far larger than its JSON, so
   * a caller that knows better should pass `tokenEstimate` explicitly — see
   * `estimateMessages`.
   */
  estimateMessage(message) {
    if (!message) return 0;
    // A cached estimate is authoritative: it was computed once at write time,
    // and the count for a stored message never changes.
    if (Number.isFinite(message.tokenEstimate)) return message.tokenEstimate;

    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    return this.estimateText(content) + this.perMessageOverhead;
  }

  estimateMessages(messages = []) {
    return messages.reduce((total, message) => total + this.estimateMessage(message), 0);
  }
}

/**
 * A `TokenEstimator` that learns from what providers actually reported.
 *
 * Providers return real `promptTokens` in their usage data. Comparing that to
 * what we predicted yields a correction factor, and after a single turn the
 * estimate for *this* conversation — with its particular language, code density
 * and formatting — is far more accurate than any generic heuristic
 * (docs/backend/06-context-engine.md#self-calibration).
 *
 * **Per-conversation, not global.** A conversation is homogeneous: mostly
 * Python, or mostly Japanese, or mostly prose. A global factor averages across
 * all of them and is right for none.
 *
 * Deterministic: the factor is a pure function of the observations recorded so
 * far, so replaying the same observations reproduces the same estimates.
 */
export class CalibratedTokenEstimator extends TokenEstimator {
  /**
   * Clamped so one anomalous response — a tool-call-heavy turn, a truncated
   * reply — cannot poison the factor. Without the clamp a single bad sample
   * distorts every subsequent estimate in the conversation.
   */
  static MIN_FACTOR = 0.7;
  static MAX_FACTOR = 1.4;

  constructor(options = {}) {
    super(options);
    this.observations = [];
    this.correctionFactor = 1;
  }

  /**
   * Record what the provider actually counted against what we predicted.
   * @param {number} estimated
   * @param {number} actual
   */
  calibrate(estimated, actual) {
    if (!(estimated > 0) || !(actual > 0)) return this.correctionFactor;

    this.observations.push({ estimated, actual });
    // Only the recent past is representative: a conversation that switched from
    // prose to code should re-learn rather than average over its whole history.
    if (this.observations.length > 5) this.observations.shift();

    const totalEstimated = this.observations.reduce((s, o) => s + o.estimated, 0);
    const totalActual = this.observations.reduce((s, o) => s + o.actual, 0);

    this.correctionFactor = clamp(
      totalActual / totalEstimated,
      CalibratedTokenEstimator.MIN_FACTOR,
      CalibratedTokenEstimator.MAX_FACTOR
    );
    return this.correctionFactor;
  }

  estimateText(text) {
    return Math.ceil(super.estimateText(text) * this.correctionFactor);
  }

  estimateMessage(message) {
    if (Number.isFinite(message?.tokenEstimate)) return message.tokenEstimate;
    return Math.ceil(super.estimateMessage(message) * this.correctionFactor);
  }

  /** How wrong the raw heuristic has been. Feeds `nova_token_estimate_error_ratio`. */
  get errorRatio() {
    if (!this.observations.length) return null;
    const totalEstimated = this.observations.reduce((s, o) => s + o.estimated, 0);
    const totalActual = this.observations.reduce((s, o) => s + o.actual, 0);
    return totalEstimated / totalActual;
  }

  /** Restore a factor persisted with a conversation, so calibration survives a restart. */
  static fromFactor(factor, options = {}) {
    const estimator = new CalibratedTokenEstimator(options);
    estimator.correctionFactor = clamp(
      factor,
      CalibratedTokenEstimator.MIN_FACTOR,
      CalibratedTokenEstimator.MAX_FACTOR
    );
    return estimator;
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
