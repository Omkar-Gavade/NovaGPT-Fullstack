import mongoose from "mongoose";
import { ThreadSchema } from "./ThreadSchema.js";
import { Thread } from "../../../domain/conversation/Thread.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * Mongo implementation of `ThreadRepositoryPort`.
 *
 * The only file in the system that knows conversations live in Mongo. It maps
 * documents to aggregates on the way out and back on the way in, so a Mongoose
 * document never escapes this layer — letting one out would couple the API
 * shape to the schema and make any migration a breaking API change
 * (docs/backend/09-api-design.md#principles).
 *
 * **Ownership is enforced in the query, never after loading.** Load-then-compare
 * works until someone writes a new query and forgets the comparison; scoping at
 * the filter means the wrong user's data is never in memory at all.
 */
export class MongoThreadRepository {
  name = "threads";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "thread-repository" }) ?? logger;
    this.clock = clock;
    // Registered lazily and once: re-registering a model on the same mongoose
    // instance throws, which would break any second container in a test run.
    this.model = mongoose.models.Thread ?? mongoose.model("Thread", ThreadSchema);
  }

  /**
   * Owner scoping, applied to every read.
   *
   * `userId` is always in the filter, including when it is `null`. An earlier
   * version omitted the clause for a null owner, which was the pre-auth
   * single-user mode and was harmless while there were no accounts — and is a
   * cross-user disclosure the moment there are. Anonymous callers scope to
   * `null` and see threads with no owner, which is a scope and not a wildcard
   * (docs/backend/10-security.md#authorization).
   */
  #scope(filter, ownerId) {
    return { ...filter, deletedAt: null, userId: ownerId ?? null };
  }

  async findById(id, ownerId = null) {
    this.#assertConnected();
    const doc = await this.model.findOne(this.#scope({ id }, ownerId)).lean();
    return doc ? toThread(doc) : null;
  }

  /** Unscoped, deliberately: see the port definition for the one use. */
  async existsById(id) {
    this.#assertConnected();
    return (await this.model.countDocuments({ id, deletedAt: null }).limit(1)) > 0;
  }

  /**
   * Public share lookup — deliberately unscoped by owner, because a share link
   * is precisely a grant to someone who is not the owner.
   */
  async findByShareId(shareId) {
    this.#assertConnected();
    const doc = await this.model.findOne({ shareId, deletedAt: null }).lean();
    return doc ? toThread(doc) : null;
  }

  /**
   * Cursor-paginated list.
   *
   * Cursors rather than offsets because the sort key (`updatedAt`) changes
   * constantly as conversations receive messages: with an offset, a thread that
   * moves to the top between pages makes the client see one item twice and miss
   * another (docs/backend/15-decisions.md#adr-015--cursor-pagination-everywhere).
   *
   * Messages are projected out — the sidebar needs titles, not bodies, and
   * loading every message of every thread to render a list is the single
   * easiest way to make this endpoint slow.
   */
  async list({ ownerId = null, archived = false, limit = 20, cursor = null, query = null } = {}) {
    this.#assertConnected();

    const filter = this.#scope({ archived }, ownerId);
    if (query) filter.title = { $regex: escapeRegex(query), $options: "i" };

    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Compound comparison so threads sharing an `updatedAt` are not skipped.
      filter.$or = [
        { updatedAt: { $lt: new Date(decoded.updatedAt) } },
        { updatedAt: new Date(decoded.updatedAt), id: { $lt: decoded.id } },
      ];
    }

    const docs = await this.model
      .find(filter)
      .sort({ updatedAt: -1, id: -1 })
      .limit(limit + 1) // one extra reveals whether another page exists
      .select("-messages")
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page.at(-1);

    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Upsert the whole aggregate.
   *
   * Whole-document rather than `$push` because the domain returns a complete
   * new `Thread` from every mutation. `_v` gives optimistic concurrency: two
   * tabs sending on one thread collide loudly rather than one silently
   * overwriting the other's turn.
   */
  async save(thread) {
    this.#assertConnected();
    const doc = thread.toJSON();

    try {
      const result = await this.model.findOneAndUpdate(
        // `userId` is in the filter, not only in the update. A caller who
        // supplies another user's thread id would otherwise upsert straight
        // over that conversation. With the clause, the filter misses, the
        // upsert attempts an insert, and the unique index on `id` refuses it.
        { id: doc.id, deletedAt: null, userId: doc.userId ?? null },
        { $set: { ...doc, updatedAt: new Date(doc.updatedAt) } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      return toThread(result.toObject ? result.toObject() : result);
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("That conversation id is already in use.", ErrorKind.CONFLICT, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async softDelete(id, ownerId = null) {
    this.#assertConnected();
    const result = await this.model.updateOne(this.#scope({ id }, ownerId), {
      $set: { deletedAt: this.clock ? new Date(this.clock.now()) : new Date() },
    });
    return result.matchedCount > 0;
  }

  /** Purge past the undo window. A "delete" that never deletes is a lie. */
  async purgeDeletedBefore(cutoff) {
    this.#assertConnected();
    const result = await this.model.deleteMany({ deletedAt: { $lt: cutoff } });
    return result.deletedCount ?? 0;
  }

  async isHealthy() {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Fail fast and specifically when the database is unreachable.
   *
   * Without this the driver buffers the operation and the caller waits out a
   * server-selection timeout, turning a clear "storage unavailable" into a slow
   * mystery. The catalog keeps serving either way
   * (docs/backend/13-deployment.md#degradation-matrix).
   */
  #assertConnected() {
    if (mongoose.connection.readyState !== 1) {
      throw new AppError(
        "Conversation storage is temporarily unavailable.",
        ErrorKind.PROVIDER_UNAVAILABLE,
        { details: { dependency: "mongodb" } }
      );
    }
  }
}

function toThread(doc) {
  return new Thread({
    ...doc,
    messages: doc.messages ?? [],
    settings: doc.settings ?? {},
  });
}

/** List projection: everything the sidebar renders, and nothing it does not. */
function toSummary(doc) {
  return {
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
  };
}

/**
 * Cursors are opaque base64 of `{updatedAt, id}`.
 *
 * Documented as opaque precisely so the encoding can change without breaking
 * clients that stored one.
 */
const encodeCursor = (doc) =>
  Buffer.from(JSON.stringify({ updatedAt: doc.updatedAt, id: doc.id })).toString("base64url");

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return parsed.updatedAt && parsed.id ? parsed : null;
  } catch {
    // A malformed cursor returns the first page rather than an error: it is
    // almost always a stale bookmark, and failing the request helps nobody.
    return null;
  }
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
