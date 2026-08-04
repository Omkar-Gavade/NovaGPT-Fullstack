import mongoose from "mongoose";
import { ulid } from "ulid";
import { AuditSchema } from "./IdentitySchemas.js";

/**
 * Mongo implementation of `AuditLogPort`.
 *
 * **Append and query. There is no update and no delete, at any level of this
 * class.** That is not the real enforcement — the application's database user
 * has `insert` and `find` on this collection and nothing else
 * (docs/backend/13-deployment.md). Enforcement in code is defeated by exactly
 * the compromise that made the log worth tampering with (T12). The omission
 * here is so that a future reader does not add the missing method and quietly
 * remove the property.
 *
 * **A failed audit write never fails the request.** An audit trail is a
 * derivative concern; refusing a user's login because the trail could not be
 * written trades a security-visibility gap for an availability outage. It is
 * logged at error level, which is what makes the gap noticed.
 */
export class MongoAuditLog {
  name = "audit";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "audit" }) ?? logger;
    this.clock = clock;
    this.model = mongoose.models.AuditEntry ?? mongoose.model("AuditEntry", AuditSchema);
  }

  async append(entry) {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error("mongo not connected");
      await this.model.create({
        id: ulid(),
        at: new Date(this.clock.now()),
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorIp: entry.actorIp ?? null,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome,
        traceId: entry.traceId ?? null,
        metadata: entry.metadata ?? null,
      });
    } catch (error) {
      this.logger?.error("audit.write_failed", { action: entry.action, error });
    }
  }

  async query({ actorId = null, action = null, limit = 50, before = null } = {}) {
    const filter = {};
    if (actorId) filter.actorId = actorId;
    if (action) filter.action = action;
    if (before) filter.at = { $lt: new Date(before) };

    const docs = await this.model.find(filter).sort({ at: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;

    return {
      items: items.map(toEntry),
      nextCursor: hasMore ? items.at(-1)?.at?.toISOString() ?? null : null,
    };
  }
}

const toEntry = (doc) => ({
  id: doc.id,
  at: doc.at instanceof Date ? doc.at.toISOString() : doc.at,
  action: doc.action,
  actorId: doc.actorId ?? null,
  actorIp: doc.actorIp ?? null,
  resourceType: doc.resourceType ?? null,
  resourceId: doc.resourceId ?? null,
  outcome: doc.outcome,
  traceId: doc.traceId ?? null,
  metadata: doc.metadata ?? null,
});
