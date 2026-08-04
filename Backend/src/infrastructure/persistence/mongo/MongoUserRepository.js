import mongoose from "mongoose";
import { UserSchema } from "./IdentitySchemas.js";
import { User } from "../../../domain/identity/User.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * Mongo implementation of `UserRepositoryPort`.
 *
 * The unique index on `email` is the actual guard against duplicate accounts.
 * A `findByEmail` check followed by an insert looks equivalent and is not: two
 * simultaneous registrations both find nothing and both insert. The duplicate
 * key error below is the race being handled, not an unexpected failure.
 */
export class MongoUserRepository {
  name = "users";

  constructor({ connection, logger, clock }) {
    this.connection = connection;
    this.logger = logger?.child?.({ component: "user-repository" }) ?? logger;
    this.clock = clock;
    this.model = mongoose.models.User ?? mongoose.model("User", UserSchema);
  }

  async findById(id) {
    this.#assertConnected();
    const doc = await this.model.findOne({ id }).lean();
    return doc ? new User(doc) : null;
  }

  /** `email` must already be normalised — normalisation belongs to the domain. */
  async findByEmail(email) {
    this.#assertConnected();
    const doc = await this.model.findOne({ email }).lean();
    return doc ? new User(doc) : null;
  }

  async exists(email) {
    this.#assertConnected();
    return (await this.model.countDocuments({ email }).limit(1)) > 0;
  }

  async count() {
    this.#assertConnected();
    return this.model.countDocuments();
  }

  async save(user) {
    this.#assertConnected();
    const doc = user.toJSON();

    try {
      const result = await this.model.findOneAndUpdate(
        { id: doc.id },
        { $set: doc },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return new User(result.toObject ? result.toObject() : result);
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("That email is already registered.", ErrorKind.CONFLICT, {
          field: "email",
          cause: error,
        });
      }
      throw error;
    }
  }

  async isHealthy() {
    return mongoose.connection.readyState === 1;
  }

  #assertConnected() {
    if (mongoose.connection.readyState !== 1) {
      throw new AppError("Accounts are temporarily unavailable.", ErrorKind.PROVIDER_UNAVAILABLE, {
        details: { dependency: "mongodb" },
      });
    }
  }
}
