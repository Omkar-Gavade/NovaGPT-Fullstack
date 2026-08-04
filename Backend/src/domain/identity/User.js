import { Role, isRole } from "./Role.js";
import { Principal } from "./Principal.js";

/**
 * A registered account.
 *
 * Immutable, like `Thread`: every transition returns a new `User`. Login
 * outcomes race — two tabs, a retry, a stuck request — and a mutable account
 * object makes the resulting interleaving impossible to reason about.
 *
 * `passwordHash` lives on the aggregate but never leaves it: `toJSON()` is the
 * persistence shape and `toPublicJSON()` is the API shape, and the API shape is
 * built field by field so a serialiser cannot ship the hash by spreading
 * (docs/backend/10-security.md#structural-defences-against-leakage-t1).
 */
export class User {
  constructor(raw = {}) {
    if (!raw.id) throw new TypeError("A user needs an id");
    if (!raw.email) throw new TypeError("A user needs an email");

    this.id = raw.id;
    this.email = raw.email;
    this.passwordHash = raw.passwordHash ?? null;
    // An unknown stored role degrades to the least privilege rather than
    // throwing: a bad row must not lock a user out of a support conversation,
    // and it certainly must not escalate.
    this.role = isRole(raw.role) ? raw.role : Role.USER;
    this.displayName = raw.displayName ?? null;

    this.failedLoginCount = Number.isInteger(raw.failedLoginCount) ? raw.failedLoginCount : 0;
    this.lockedUntil = raw.lockedUntil ? new Date(raw.lockedUntil) : null;

    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    this.updatedAt = raw.updatedAt ? new Date(raw.updatedAt) : this.createdAt;
    this.lastLoginAt = raw.lastLoginAt ? new Date(raw.lastLoginAt) : null;
    this.passwordChangedAt = raw.passwordChangedAt ? new Date(raw.passwordChangedAt) : this.createdAt;
    this.disabledAt = raw.disabledAt ? new Date(raw.disabledAt) : null;

    Object.freeze(this);
  }

  get isDisabled() {
    return this.disabledAt !== null;
  }

  isLocked(now) {
    return this.lockedUntil !== null && this.lockedUntil.getTime() > now;
  }

  lockRemainingMs(now) {
    return this.isLocked(now) ? this.lockedUntil.getTime() - now : 0;
  }

  /** Record a failed attempt and apply the escalating lock. */
  withFailedLogin(now, policy) {
    const failedLoginCount = this.failedLoginCount + 1;
    return new User({
      ...this.toJSON(),
      failedLoginCount,
      lockedUntil: policy.lockedUntil(failedLoginCount, now),
      updatedAt: new Date(now),
    });
  }

  /** Reset the counter. A successful login clears the escalation entirely. */
  withSuccessfulLogin(now) {
    return new User({
      ...this.toJSON(),
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(now),
      updatedAt: new Date(now),
    });
  }

  /**
   * Change the password.
   *
   * `passwordChangedAt` moves, and every access token issued before that
   * instant stops being accepted. Without it a password change does not evict
   * a thief who already holds a token — which is the one thing a user changing
   * their password is trying to do.
   */
  withPassword(passwordHash, now) {
    return new User({
      ...this.toJSON(),
      passwordHash,
      passwordChangedAt: new Date(now),
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: new Date(now),
    });
  }

  toPrincipal({ tokenId = null, sessionId = null } = {}) {
    return new Principal({
      id: this.id,
      role: this.role,
      email: this.email,
      tokenId,
      sessionId,
    });
  }

  /** Persistence shape. Includes the hash; never returned over HTTP. */
  toJSON() {
    return {
      id: this.id,
      email: this.email,
      passwordHash: this.passwordHash,
      role: this.role,
      displayName: this.displayName,
      failedLoginCount: this.failedLoginCount,
      lockedUntil: this.lockedUntil?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
      passwordChangedAt: this.passwordChangedAt.toISOString(),
      disabledAt: this.disabledAt?.toISOString() ?? null,
    };
  }

  /** API shape. Built field by field, so the hash cannot arrive by accident. */
  toPublicJSON() {
    return {
      id: this.id,
      email: this.email,
      role: this.role,
      displayName: this.displayName,
      createdAt: this.createdAt.toISOString(),
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
    };
  }
}
