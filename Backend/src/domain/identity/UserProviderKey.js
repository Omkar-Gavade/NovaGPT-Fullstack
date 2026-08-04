/**
 * One user's credential for one provider, encrypted.
 *
 * **The plaintext never lives on this object.** It exists in memory for the
 * duration of a store or a request and nowhere else — the aggregate carries
 * ciphertext and a mask, so an accidental `JSON.stringify` of a user's record
 * produces `sk-…7f2a` rather than a key
 * (docs/backend/10-security.md#rules-for-user-supplied-keys).
 *
 * The mask is stored rather than derived, because deriving it would require
 * decrypting — turning "show me which key this is" into an operation that
 * touches the master key on every list request.
 */
export class UserProviderKey {
  constructor(raw = {}) {
    if (!raw.userId) throw new TypeError("A user key needs a user id");
    if (!raw.provider) throw new TypeError("A user key needs a provider");

    this.userId = raw.userId;
    this.provider = raw.provider;

    // The envelope: ciphertext, wrapped data key, IVs and auth tags. Opaque
    // here on purpose — the domain does not know how encryption works, only
    // that this blob is what the cipher needs back.
    this.envelope = raw.envelope ?? null;

    // `sk-…7f2a`. The only thing about a stored key that is ever returned.
    this.mask = raw.mask ?? "…";

    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    this.updatedAt = raw.updatedAt ? new Date(raw.updatedAt) : this.createdAt;
    // Set when the key last worked against the provider. A key that has never
    // validated is a key the user should be told about before they rely on it.
    this.lastValidatedAt = raw.lastValidatedAt ? new Date(raw.lastValidatedAt) : null;
    // Set when the provider rejected it. Distinct from "never validated".
    this.lastRejectedAt = raw.lastRejectedAt ? new Date(raw.lastRejectedAt) : null;

    Object.freeze(this);
  }

  get isRejected() {
    return (
      this.lastRejectedAt !== null &&
      (this.lastValidatedAt === null || this.lastRejectedAt > this.lastValidatedAt)
    );
  }

  validated(now) {
    return new UserProviderKey({ ...this.toJSON(), lastValidatedAt: new Date(now).toISOString() });
  }

  rejected(now) {
    return new UserProviderKey({ ...this.toJSON(), lastRejectedAt: new Date(now).toISOString() });
  }

  /** Persistence shape. Carries the envelope, never a plaintext key. */
  toJSON() {
    return {
      userId: this.userId,
      provider: this.provider,
      envelope: this.envelope,
      mask: this.mask,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      lastValidatedAt: this.lastValidatedAt?.toISOString() ?? null,
      lastRejectedAt: this.lastRejectedAt?.toISOString() ?? null,
    };
  }

  /**
   * API shape. Built field by field, and **the envelope is not in it**.
   *
   * A user who has lost their key retrieves it from the provider, not from us.
   */
  toPublicJSON() {
    return {
      provider: this.provider,
      mask: this.mask,
      createdAt: this.createdAt.toISOString(),
      lastValidatedAt: this.lastValidatedAt?.toISOString() ?? null,
      status: this.isRejected ? "rejected" : this.lastValidatedAt ? "active" : "unverified",
    };
  }
}
