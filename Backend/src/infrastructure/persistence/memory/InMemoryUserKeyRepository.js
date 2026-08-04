import { UserProviderKey } from "../../../domain/identity/UserProviderKey.js";

/**
 * In-process implementation of `UserKeyRepositoryPort`.
 *
 * `remove` deletes the entry rather than flagging it, matching Mongo — a double
 * that soft-deleted would let a test assert deletion the real implementation
 * does differently, on the one operation where the difference matters most.
 */
export class InMemoryUserKeyRepository {
  name = "user-keys";
  kind = "memory";

  constructor({ clock } = {}) {
    this.clock = clock;
    /** @type {Map<string, object>} `${userId}:${provider}` -> plain JSON */
    this.store = new Map();
  }

  #key(userId, provider) {
    return `${userId}:${provider}`;
  }

  async find(userId, provider) {
    const doc = this.store.get(this.#key(userId, provider));
    return doc ? new UserProviderKey(doc) : null;
  }

  async listForUser(userId) {
    return [...this.store.values()]
      .filter((doc) => doc.userId === userId)
      .map((doc) => new UserProviderKey(doc));
  }

  async save(record) {
    const doc = record.toJSON();
    this.store.set(this.#key(doc.userId, doc.provider), doc);
  }

  async remove(userId, provider) {
    return this.store.delete(this.#key(userId, provider));
  }

  clear() {
    this.store.clear();
  }
}
