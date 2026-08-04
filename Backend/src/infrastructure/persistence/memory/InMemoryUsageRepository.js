/**
 * In-process implementation of `UsageRepositoryPort`.
 *
 * A real implementation, and the aggregation below deliberately mirrors the
 * Mongo pipeline — including treating a `null` cost as zero when summing while
 * keeping it `null` on the record. A double that summed differently would let a
 * cost test pass here and be wrong in production.
 */
export class InMemoryUsageRepository {
  name = "usage";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    /** @type {import("../../../domain/usage/UsageRecord.js").UsageRecord[]} */
    this.records = [];
  }

  async record(usageRecord) {
    this.records.push(usageRecord);
  }

  async list({ traceId = null, userId = null, since = null, limit = 200 } = {}) {
    let found = this.records.filter(
      (r) =>
        (!traceId || r.traceId === traceId) &&
        (!userId || r.userId === userId) &&
        (!since || r.at >= new Date(since))
    );

    found = traceId
      ? found.sort((a, b) => a.attempt - b.attempt)
      : found.sort((a, b) => b.at - a.at);

    return found.slice(0, limit).map((r) => r.toJSON());
  }

  async summarise({ userId = null, provider = null, since = null } = {}) {
    const scoped = this.records.filter(
      (r) =>
        (!userId || r.userId === userId) &&
        (!provider || r.provider === provider) &&
        (!since || r.at >= new Date(since))
    );

    return scoped.reduce(
      (acc, r) => ({
        attempts: acc.attempts + 1,
        tokens: acc.tokens + r.totalTokens,
        costUsd: acc.costUsd + (r.costUsd ?? 0),
        wastedTokens: acc.wastedTokens + (r.isWaste ? r.totalTokens : 0),
      }),
      { attempts: 0, tokens: 0, costUsd: 0, wastedTokens: 0 }
    );
  }

  async purgeBefore(cutoff) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.at >= cutoff);
    return before - this.records.length;
  }

  find(outcome) {
    return this.records.filter((r) => r.outcome === outcome);
  }

  clear() {
    this.records.length = 0;
  }
}
