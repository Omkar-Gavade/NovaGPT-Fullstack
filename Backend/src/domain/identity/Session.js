/**
 * One refresh token, and the family it belongs to.
 *
 * A *family* is a login. Every refresh mints a new token in the same family and
 * marks the previous one used. That is what makes theft detectable: if a token
 * that has already been rotated is presented again, either the legitimate
 * client or the thief is replaying — and there is no way to tell which, so the
 * whole family is revoked and the user starts over
 * (docs/backend/10-security.md#authentication).
 *
 * Without rotation, a stolen 30-day refresh token is 30 days of undetectable
 * access. With it, the second use is an alarm.
 */
export class Session {
  constructor(raw = {}) {
    if (!raw.id) throw new TypeError("A session needs an id");
    if (!raw.familyId) throw new TypeError("A session needs a family id");
    if (!raw.userId) throw new TypeError("A session needs a user id");

    this.id = raw.id;
    this.familyId = raw.familyId;
    this.userId = raw.userId;

    // The token itself is never stored — only a hash of it. A database dump
    // then yields nothing usable, the same reasoning as password hashing.
    this.tokenHash = raw.tokenHash ?? null;

    this.issuedAt = raw.issuedAt ? new Date(raw.issuedAt) : new Date();
    this.expiresAt = new Date(raw.expiresAt);
    this.usedAt = raw.usedAt ? new Date(raw.usedAt) : null;
    this.revokedAt = raw.revokedAt ? new Date(raw.revokedAt) : null;
    this.replacedBy = raw.replacedBy ?? null;

    // Recorded for the audit trail. Hashed, not raw: a user agent plus an IP is
    // a fingerprint, and the audit log is not the place to keep one in the
    // clear (docs/backend/10-security.md#audit-logging).
    this.clientHash = raw.clientHash ?? null;

    Object.freeze(this);
  }

  get isUsed() {
    return this.usedAt !== null;
  }

  get isRevoked() {
    return this.revokedAt !== null;
  }

  isExpired(now) {
    return this.expiresAt.getTime() <= now;
  }

  isUsable(now) {
    return !this.isUsed && !this.isRevoked && !this.isExpired(now);
  }

  /** Mark this token rotated, naming its successor. */
  rotatedTo(successorId, now) {
    return new Session({
      ...this.toJSON(),
      usedAt: new Date(now).toISOString(),
      replacedBy: successorId,
    });
  }

  revoked(now) {
    return new Session({ ...this.toJSON(), revokedAt: new Date(now).toISOString() });
  }

  toJSON() {
    return {
      id: this.id,
      familyId: this.familyId,
      userId: this.userId,
      tokenHash: this.tokenHash,
      issuedAt: this.issuedAt.toISOString(),
      expiresAt: this.expiresAt.toISOString(),
      usedAt: this.usedAt?.toISOString() ?? null,
      revokedAt: this.revokedAt?.toISOString() ?? null,
      replacedBy: this.replacedBy,
      clientHash: this.clientHash,
    };
  }
}
