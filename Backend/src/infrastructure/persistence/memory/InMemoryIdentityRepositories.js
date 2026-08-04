import { ulid } from "ulid";
import { User } from "../../../domain/identity/User.js";
import { Session } from "../../../domain/identity/Session.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * In-process implementations of the identity ports.
 *
 * Real implementations, not stubs — the same arrangement as
 * `InMemoryThreadRepository`. Tests exercise these, and so does a local run
 * with no database, which is what keeps the zero-dependency path honest.
 *
 * The scope limitation is stated rather than hidden: accounts live for the life
 * of the process. Never a production store.
 */

export class InMemoryUserRepository {
  name = "users";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    /** @type {Map<string, object>} id -> plain user JSON */
    this.byId = new Map();
    /** @type {Map<string, string>} email -> id */
    this.byEmail = new Map();
  }

  async findById(id) {
    const doc = this.byId.get(id);
    return doc ? new User(doc) : null;
  }

  async findByEmail(email) {
    const id = this.byEmail.get(email);
    return id ? this.findById(id) : null;
  }

  async exists(email) {
    return this.byEmail.has(email);
  }

  async count() {
    return this.byId.size;
  }

  async save(user) {
    const doc = user.toJSON();
    // Mirrors the Mongo unique index. Without it, a test would pass here and
    // the constraint would only be discovered in production.
    const existing = this.byEmail.get(doc.email);
    if (existing && existing !== doc.id) {
      throw new AppError("That email is already registered.", ErrorKind.CONFLICT, {
        field: "email",
      });
    }
    this.byId.set(doc.id, doc);
    this.byEmail.set(doc.email, doc.id);
    return new User(doc);
  }

  async isHealthy() {
    return true;
  }

  clear() {
    this.byId.clear();
    this.byEmail.clear();
  }
}

export class InMemorySessionRepository {
  name = "sessions";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    /** @type {Map<string, object>} */
    this.store = new Map();
  }

  async findById(id) {
    const doc = this.store.get(id);
    return doc ? new Session(doc) : null;
  }

  async save(session) {
    const doc = session.toJSON();
    this.store.set(doc.id, doc);
    return new Session(doc);
  }

  async revokeFamily(familyId, now) {
    let revoked = 0;
    for (const [id, doc] of this.store) {
      if (doc.familyId === familyId && !doc.revokedAt) {
        this.store.set(id, { ...doc, revokedAt: new Date(now).toISOString() });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeAllForUser(userId, now) {
    let revoked = 0;
    for (const [id, doc] of this.store) {
      if (doc.userId === userId && !doc.revokedAt) {
        this.store.set(id, { ...doc, revokedAt: new Date(now).toISOString() });
        revoked += 1;
      }
    }
    return revoked;
  }

  async purgeExpiredBefore(cutoff) {
    let purged = 0;
    for (const [id, doc] of this.store) {
      if (new Date(doc.expiresAt) < cutoff) {
        this.store.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  clear() {
    this.store.clear();
  }
}

/**
 * In-process audit log.
 *
 * Append and query only, exactly like the Mongo one — a test double that
 * permitted deletion would let a test assert behaviour the real implementation
 * cannot have.
 */
export class InMemoryAuditLog {
  name = "audit";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    this.entries = [];
  }

  async append(entry) {
    this.entries.push({
      id: ulid(),
      at: new Date(this.clock ? this.clock.now() : Date.now()).toISOString(),
      actorId: null,
      actorIp: null,
      resourceType: null,
      resourceId: null,
      traceId: null,
      metadata: null,
      ...entry,
    });
  }

  async query({ actorId = null, action = null, limit = 50 } = {}) {
    const items = this.entries
      .filter((e) => (!actorId || e.actorId === actorId) && (!action || e.action === action))
      .slice()
      .reverse()
      .slice(0, limit);
    return { items, nextCursor: null };
  }

  find(action) {
    return this.entries.filter((e) => e.action === action);
  }

  clear() {
    this.entries.length = 0;
  }
}
