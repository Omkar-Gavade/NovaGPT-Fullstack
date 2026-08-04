import { Thread } from "../../../domain/conversation/Thread.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * In-process implementation of `ThreadRepositoryPort`.
 *
 * Not a stub. It is the same arrangement as `InMemoryCache`: a real
 * implementation of the port used by tests and by a zero-dependency local run.
 * Making the alternative path a real implementation — rather than conditionals
 * inside callers — is what keeps it testable
 * (docs/backend/08-storage.md#redis-must-be-optional-and-what-that-costs).
 *
 * The scope limitation is stated rather than hidden: data lives for the life of
 * the process. It is never a production store.
 */
export class InMemoryThreadRepository {
  name = "threads";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    /** @type {Map<string, object>} id -> plain thread JSON */
    this.store = new Map();
  }

  #now() {
    return this.clock ? new Date(this.clock.now()) : new Date();
  }

  /**
   * Owner scoping applied identically to the Mongo implementation.
   *
   * Strict equality, including `null`. An earlier version treated a `null`
   * owner as "no scope requested" and returned every thread — which was
   * harmless while there were no accounts and is a cross-user disclosure the
   * moment there are. `null` is an owner like any other: anonymous callers see
   * threads with no owner, and nothing else
   * (docs/backend/10-security.md#authorization).
   */
  #visible(doc, ownerId) {
    if (!doc || doc.deletedAt) return false;
    return (doc.userId ?? null) === (ownerId ?? null);
  }

  async findById(id, ownerId = null) {
    const doc = this.store.get(id);
    return this.#visible(doc, ownerId) ? new Thread(doc) : null;
  }

  /** Unscoped, deliberately: see the port definition for the one use. */
  async existsById(id) {
    const doc = this.store.get(id);
    return Boolean(doc) && !doc.deletedAt;
  }

  async findByShareId(shareId) {
    for (const doc of this.store.values()) {
      if (doc.shareId === shareId && !doc.deletedAt) return new Thread(doc);
    }
    return null;
  }

  async list({ ownerId = null, archived = false, limit = 20, cursor = null, query = null } = {}) {
    let docs = [...this.store.values()]
      .filter((doc) => this.#visible(doc, ownerId) && Boolean(doc.archived) === Boolean(archived))
      .filter((doc) => !query || doc.title.toLowerCase().includes(query.toLowerCase()))
      // Same ordering as Mongo, including the id tiebreak, so a test written
      // against one implementation describes the other.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        docs = docs.filter(
          (doc) =>
            doc.updatedAt < decoded.updatedAt ||
            (doc.updatedAt === decoded.updatedAt && doc.id < decoded.id)
        );
      }
    }

    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit);
    const last = page.at(-1);

    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Upsert, refusing to write across an owner boundary.
   *
   * The Mongo implementation gets this from the unique index on `id`; here it
   * is explicit, so both implementations reject the same write. Without it, a
   * caller who supplies another user's thread id on a send would overwrite that
   * conversation with their own.
   */
  async save(thread) {
    const doc = thread.toJSON();
    const existing = this.store.get(doc.id);
    if (existing && (existing.userId ?? null) !== (doc.userId ?? null)) {
      throw new AppError("That conversation id is already in use.", ErrorKind.CONFLICT);
    }
    this.store.set(doc.id, doc);
    return new Thread(doc);
  }

  async softDelete(id, ownerId = null) {
    const doc = this.store.get(id);
    if (!this.#visible(doc, ownerId)) return false;
    this.store.set(id, { ...doc, deletedAt: this.#now().toISOString() });
    return true;
  }

  async purgeDeletedBefore(cutoff) {
    let purged = 0;
    for (const [id, doc] of this.store) {
      if (doc.deletedAt && new Date(doc.deletedAt) < cutoff) {
        this.store.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  async isHealthy() {
    return true;
  }

  clear() {
    this.store.clear();
  }
}

const toSummary = (doc) => ({
  id: doc.id,
  title: doc.title,
  pinned: doc.pinned,
  archived: doc.archived,
  messageCount: doc.messageCount ?? 0,
  totalTokens: doc.totalTokens ?? 0,
  shareId: doc.shareId ?? null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  lastMessageAt: doc.lastMessageAt ?? null,
});

const encodeCursor = (doc) =>
  Buffer.from(JSON.stringify({ updatedAt: doc.updatedAt, id: doc.id })).toString("base64url");

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return parsed.updatedAt && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}
