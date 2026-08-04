import mongoose from "mongoose";
import { UserProviderKey } from "../../../domain/identity/UserProviderKey.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * The Mongo shape of a stored user key.
 *
 * The envelope is `Mixed` because its internals belong to `EnvelopeCipher`, not
 * to the schema — a typed schema here would have to change every time the
 * cipher's record format did, and the format is deliberately versioned inside
 * the record instead.
 */
const UserKeySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    provider: { type: String, required: true },
    envelope: { type: mongoose.Schema.Types.Mixed, required: true },
    // `sk-…7f2a`. The only part ever returned to anyone.
    mask: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastValidatedAt: { type: Date, default: null },
    lastRejectedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

// One key per user per provider, enforced by the database rather than by a
// check-then-insert that two concurrent requests both pass.
UserKeySchema.index({ userId: 1, provider: 1 }, { unique: true });

export class MongoUserKeyRepository {
  name = "user-keys";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "user-key-repository" }) ?? logger;
    this.clock = clock;
    this.model = mongoose.models.UserProviderKey ?? mongoose.model("UserProviderKey", UserKeySchema);
  }

  async find(userId, provider) {
    this.#assertConnected();
    const doc = await this.model.findOne({ userId, provider }).lean();
    return doc ? new UserProviderKey(doc) : null;
  }

  async listForUser(userId) {
    this.#assertConnected();
    const docs = await this.model.find({ userId }).lean();
    return docs.map((doc) => new UserProviderKey(doc));
  }

  async save(record) {
    this.#assertConnected();
    const doc = record.toJSON();
    await this.model.findOneAndUpdate(
      { userId: doc.userId, provider: doc.provider },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  /**
   * A real delete, not a flag.
   *
   * "Deletion MUST be immediate and complete" — a soft delete would leave the
   * ciphertext in the collection and in every backup taken afterwards.
   */
  async remove(userId, provider) {
    this.#assertConnected();
    const result = await this.model.deleteOne({ userId, provider });
    return (result.deletedCount ?? 0) > 0;
  }

  #assertConnected() {
    if (mongoose.connection.readyState !== 1) {
      throw new AppError("Provider keys are temporarily unavailable.", ErrorKind.PROVIDER_UNAVAILABLE, {
        details: { dependency: "mongodb" },
      });
    }
  }
}
