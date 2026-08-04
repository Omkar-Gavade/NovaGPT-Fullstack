import mongoose from "mongoose";

/**
 * The Mongo shape of a usage record.
 *
 * A separate collection rather than a field on the thread, because the read
 * patterns have nothing in common: a thread is read whole by id, while usage is
 * aggregated across every thread of a user over a date range. Embedding would
 * make the spend query a full scan of every conversation
 * (docs/backend/08-storage.md).
 */
export const UsageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now },

    // The correlation key. Records sharing one, ordered by `attempt`, are the
    // failover story for a single request.
    traceId: { type: String, default: null },
    userId: { type: String, default: null },
    threadId: { type: String, default: null },

    provider: { type: String, required: true },
    model: { type: String, default: null },
    attempt: { type: Number, default: 1 },
    outcome: { type: String, enum: ["success", "failure", "cancelled"], required: true },
    failureKind: { type: String, default: null },
    streaming: { type: Boolean, default: false },

    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    // Null means the model has no price entry, which is not the same as free
    // and must not be summed as zero.
    costUsd: { type: Number, default: null },

    latencyMs: { type: Number, default: null },
    ttftMs: { type: Number, default: null },
  },
  { versionKey: false }
);

/* Every index serves a named query; an index without one is write amplification
 * and storage cost for nothing (docs/backend/08-storage.md#indexes). */

// "What did this user spend this month?" — the per-user budget query.
UsageSchema.index({ userId: 1, at: -1 });
// "What happened in this request?" — the failover story, in attempt order.
UsageSchema.index({ traceId: 1, attempt: 1 });
// "Which provider is consuming the fleet's quota?" — the cost dashboard.
UsageSchema.index({ provider: 1, at: -1 });

// 90 days, then the monthly rollup takes over
// (docs/backend/08-storage.md#retention-and-ttl). Applied by Mongo rather than
// a job, because a cleanup job that must be remembered eventually is not.
UsageSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const USAGE_COLLECTION = "usage_records";
