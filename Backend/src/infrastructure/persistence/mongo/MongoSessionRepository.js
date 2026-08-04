import mongoose from "mongoose";
import { SessionSchema } from "./IdentitySchemas.js";
import { Session } from "../../../domain/identity/Session.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/** Mongo implementation of `SessionRepositoryPort`. */
export class MongoSessionRepository {
  name = "sessions";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "session-repository" }) ?? logger;
    this.clock = clock;
    this.model = mongoose.models.Session ?? mongoose.model("Session", SessionSchema);
  }

  async findById(id) {
    this.#assertConnected();
    const doc = await this.model.findOne({ id }).lean();
    return doc ? new Session(doc) : null;
  }

  async save(session) {
    this.#assertConnected();
    const doc = session.toJSON();
    const result = await this.model.findOneAndUpdate(
      { id: doc.id },
      { $set: doc },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return new Session(result.toObject ? result.toObject() : result);
  }

  /**
   * Revoke every token in a family.
   *
   * Called when a rotated token is presented a second time. Either the real
   * client or a thief is replaying and there is no way to tell which, so the
   * only safe move is to end the family and make the user log in again
   * (docs/backend/10-security.md#authentication).
   */
  async revokeFamily(familyId, now) {
    this.#assertConnected();
    const result = await this.model.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt: now } }
    );
    return result.modifiedCount ?? 0;
  }

  async revokeAllForUser(userId, now) {
    this.#assertConnected();
    const result = await this.model.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: now } }
    );
    return result.modifiedCount ?? 0;
  }

  /** Belt and braces alongside the TTL index, which Mongo applies lazily. */
  async purgeExpiredBefore(cutoff) {
    this.#assertConnected();
    const result = await this.model.deleteMany({ expiresAt: { $lt: cutoff } });
    return result.deletedCount ?? 0;
  }

  #assertConnected() {
    if (mongoose.connection.readyState !== 1) {
      throw new AppError("Sessions are temporarily unavailable.", ErrorKind.PROVIDER_UNAVAILABLE, {
        details: { dependency: "mongodb" },
      });
    }
  }
}
