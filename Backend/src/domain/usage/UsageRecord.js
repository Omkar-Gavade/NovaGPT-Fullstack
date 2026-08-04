/**
 * One provider attempt, as an accounting fact.
 *
 * **One record per attempt, not per request.** Three records sharing a trace id
 * with ascending attempt numbers *are* the failover story, queryable without
 * touching logs (docs/backend/11-observability.md#correlation). Collapsing a
 * request into a single record would hide exactly the attempts that cost quota
 * and produced nothing.
 *
 * **Failed and cancelled attempts are recorded.** They consume real quota.
 * Excluding them understates consumption precisely where the waste lives — and
 * "15% of our tokens are burned on attempts nobody read" is the number that
 * turns a routing opinion into a decision.
 *
 * **Free-tier usage is recorded with `costUsd: 0`, and its tokens are still
 * counted.** Free tiers have limits; token consumption is the resource whether
 * or not it is billed. An unpriced model gets `costUsd: null`, which is a
 * different thing from zero and must stay different — collapsing them would
 * silently understate spend every time a model is added without a price.
 */

export const UsageOutcome = {
  SUCCESS: "success",
  FAILURE: "failure",
  CANCELLED: "cancelled",
};

export class UsageRecord {
  constructor(raw = {}) {
    if (!raw.id) throw new TypeError("A usage record needs an id");
    if (!raw.provider) throw new TypeError("A usage record needs a provider");

    this.id = raw.id;
    // The correlation key. Everything about one request hangs off it.
    this.traceId = raw.traceId ?? null;
    this.userId = raw.userId ?? null;
    this.threadId = raw.threadId ?? null;

    this.provider = raw.provider;
    this.model = raw.model ?? null;
    // 1-based, so the ordering reads the way an operator counts.
    this.attempt = Number.isInteger(raw.attempt) ? raw.attempt : 1;
    this.outcome = raw.outcome ?? UsageOutcome.SUCCESS;
    this.failureKind = raw.failureKind ?? null;
    this.streaming = raw.streaming === true;

    this.promptTokens = numberOrZero(raw.promptTokens);
    this.completionTokens = numberOrZero(raw.completionTokens);

    // `null` where the model has no price, never `0`.
    this.costUsd = typeof raw.costUsd === "number" ? raw.costUsd : null;

    this.latencyMs = numberOrNull(raw.latencyMs);
    // Time to first token. Null for a non-streaming call, and null for a stream
    // that failed before producing one — which is itself the interesting case.
    this.ttftMs = numberOrNull(raw.ttftMs);

    this.at = raw.at ? new Date(raw.at) : new Date();
    Object.freeze(this);
  }

  get totalTokens() {
    return this.promptTokens + this.completionTokens;
  }

  /** True when this attempt consumed quota and produced nothing a user read. */
  get isWaste() {
    return this.outcome !== UsageOutcome.SUCCESS;
  }

  toJSON() {
    return {
      id: this.id,
      traceId: this.traceId,
      userId: this.userId,
      threadId: this.threadId,
      provider: this.provider,
      model: this.model,
      attempt: this.attempt,
      outcome: this.outcome,
      failureKind: this.failureKind,
      streaming: this.streaming,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      costUsd: this.costUsd,
      latencyMs: this.latencyMs,
      ttftMs: this.ttftMs,
      at: this.at.toISOString(),
    };
  }
}

/**
 * A missing token count is zero, not null.
 *
 * Several providers omit usage on a failure, and summing a column of nulls is
 * how a spend report becomes `NaN`. Zero is the honest value: nothing was
 * *reported*, and inventing an estimate would be worse than under-counting.
 */
function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
