import mongoose from "mongoose";
import { UsageSchema } from "./UsageSchema.js";

/**
 * Mongo implementation of `UsageRepositoryPort`.
 *
 * **Writes never throw.** `UsageRecorder` calls this off the request's critical
 * path; a rejected promise there would be an unhandled rejection rather than a
 * handled failure. The error is logged and the request carries on, which is the
 * correct trade for accounting data (docs/backend/11-observability.md).
 */
export class MongoUsageRepository {
  name = "usage";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "usage-repository" }) ?? logger;
    this.clock = clock;
    this.model = mongoose.models.UsageRecord ?? mongoose.model("UsageRecord", UsageSchema);
  }

  async record(usageRecord) {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error("mongo not connected");
      await this.model.create(usageRecord.toJSON());
    } catch (error) {
      this.logger?.error("usage.write_failed", { provider: usageRecord.provider, error });
    }
  }

  async list({ traceId = null, userId = null, since = null, limit = 200 } = {}) {
    const filter = {};
    if (traceId) filter.traceId = traceId;
    if (userId) filter.userId = userId;
    if (since) filter.at = { $gte: new Date(since) };

    // Ascending by attempt within a trace, so the failover story reads in the
    // order it happened rather than newest-first.
    const sort = traceId ? { attempt: 1 } : { at: -1 };
    return this.model.find(filter).sort(sort).limit(limit).lean();
  }

  /**
   * Spend and consumption over a window.
   *
   * Aggregated in the database rather than in the application: the alternative
   * is streaming ninety days of records into memory to add up two columns.
   */
  async summarise({ userId = null, provider = null, since = null } = {}) {
    const match = {};
    if (userId) match.userId = userId;
    if (provider) match.provider = provider;
    if (since) match.at = { $gte: new Date(since) };

    const [result] = await this.model.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          attempts: { $sum: 1 },
          tokens: { $sum: "$totalTokens" },
          // `$ifNull` because an unpriced model stores `null`, and summing a
          // column containing one yields null for the whole group.
          costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
          wastedTokens: {
            $sum: { $cond: [{ $eq: ["$outcome", "success"] }, 0, "$totalTokens"] },
          },
        },
      },
    ]);

    return result
      ? {
          attempts: result.attempts,
          tokens: result.tokens,
          costUsd: result.costUsd,
          wastedTokens: result.wastedTokens,
        }
      : { attempts: 0, tokens: 0, costUsd: 0, wastedTokens: 0 };
  }

  async purgeBefore(cutoff) {
    const result = await this.model.deleteMany({ at: { $lt: cutoff } });
    return result.deletedCount ?? 0;
  }
}
