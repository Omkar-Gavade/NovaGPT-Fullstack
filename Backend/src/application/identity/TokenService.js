import { randomUUID, createHash } from "node:crypto";
import { Session } from "../../domain/identity/Session.js";
import { Principal } from "../../domain/identity/Principal.js";

/**
 * Issues, verifies, rotates and revokes tokens.
 *
 * Two token types with deliberately different properties:
 *
 *   access   15 minutes, stateless, verified by signature alone. No database
 *            round trip on the hot path — which is the entire reason the
 *            lifetime is short rather than long.
 *   refresh  30 days, stored (hashed), single-use, rotating. Every refresh
 *            invalidates its predecessor, so a replayed token proves the family
 *            is compromised (docs/backend/10-security.md#authentication).
 *
 * The `type` claim is checked on every verification. Without it, a refresh
 * token is a perfectly valid signed token and would be accepted as an access
 * token — a 30-day bearer credential in the `Authorization` header, which is
 * exactly what the short access lifetime exists to prevent.
 */
export class TokenService {
  constructor({ signer, sessions, denylist, clock, logger, config }) {
    this.signer = signer;
    this.sessions = sessions;
    this.denylist = denylist;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "tokens" }) ?? logger;
    this.accessTtlMs = config.accessTtlMs;
    this.refreshTtlMs = config.refreshTtlMs;
  }

  /**
   * Mint an access token plus a fresh refresh token in a new family.
   *
   * @param {import("../../domain/identity/User.js").User} user
   * @param {object} [context] client fingerprint, for the audit trail
   */
  async issue(user, { clientHash = null, familyId = randomUUID() } = {}) {
    const now = this.clock.now();
    const accessToken = this.#signAccess(user);
    const refresh = await this.#mintRefresh(user, { familyId, clientHash, now });

    return {
      accessToken: accessToken.token,
      accessTokenId: accessToken.jti,
      expiresIn: Math.floor(this.accessTtlMs / 1000),
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      sessionId: refresh.sessionId,
      familyId,
    };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * @returns {Promise<{ok: true, user: object, tokens: object} | {ok: false, reason: string}>}
   *          A result rather than an exception: "your session expired" is the
   *          normal end of every session, not an exceptional event.
   */
  async rotate(refreshToken, { users, clientHash = null } = {}) {
    const verified = this.signer.verify(refreshToken);
    if (!verified.valid) return { ok: false, reason: verified.reason };
    if (verified.claims.type !== "refresh") return { ok: false, reason: "type" };

    const now = this.clock.now();
    const session = await this.sessions.findById(verified.claims.jti);
    if (!session) return { ok: false, reason: "unknown_session" };

    // Reuse detection. A token that has already been rotated is being presented
    // a second time: either the legitimate client or a thief is replaying, and
    // there is no way to tell which. Revoking the whole family turns silent,
    // indefinite access into a contained incident the user is told about.
    if (session.isUsed || session.isRevoked) {
      const revoked = await this.sessions.revokeFamily(session.familyId, new Date(now));
      this.logger?.warn("auth.refresh_reuse_detected", {
        userId: session.userId,
        familyId: session.familyId,
        revoked,
      });
      return { ok: false, reason: "reuse_detected", userId: session.userId };
    }

    if (session.isExpired(now)) return { ok: false, reason: "expired" };

    // The stored hash is checked as well as the signature. A signature proves
    // the token was minted by us; the hash proves it is *this* session's token
    // and not another one whose id happened to be guessed into the claim.
    if (session.tokenHash !== hashToken(refreshToken)) {
      await this.sessions.revokeFamily(session.familyId, new Date(now));
      return { ok: false, reason: "reuse_detected", userId: session.userId };
    }

    const user = await users.findById(session.userId);
    if (!user || user.isDisabled) return { ok: false, reason: "unknown_user" };

    const successor = await this.#mintRefresh(user, {
      familyId: session.familyId,
      clientHash: clientHash ?? session.clientHash,
      now,
    });
    await this.sessions.save(session.rotatedTo(successor.sessionId, now));

    const access = this.#signAccess(user);
    return {
      ok: true,
      user,
      tokens: {
        accessToken: access.token,
        accessTokenId: access.jti,
        expiresIn: Math.floor(this.accessTtlMs / 1000),
        refreshToken: successor.token,
        refreshExpiresAt: successor.expiresAt,
        sessionId: successor.sessionId,
        familyId: session.familyId,
      },
    };
  }

  /**
   * Verify an access token and build the principal it represents.
   *
   * `passwordChangedAt` is compared against the token's `iat`: a password
   * change must evict tokens minted before it, or changing a password does
   * nothing about the thief who already has one.
   */
  async authenticate(token, { users } = {}) {
    const verified = this.signer.verify(token);
    if (!verified.valid) return { ok: false, reason: verified.reason };

    const claims = verified.claims;
    if (claims.type !== "access") return { ok: false, reason: "type" };
    if (await this.denylist.isRevoked(claims.jti)) return { ok: false, reason: "revoked" };

    // The token carries the role, so the common path needs no lookup. The user
    // is loaded only when there is a reason to believe the token outlived its
    // account state.
    const user = users ? await users.findById(claims.sub) : null;
    if (users) {
      if (!user || user.isDisabled) return { ok: false, reason: "unknown_user" };
      // Compared at second granularity, because `iat` *is* seconds. Comparing
      // it against a millisecond timestamp rejects every token minted in the
      // same second as the account was created — which is every token issued by
      // registration, so nobody could use the account they just made.
      if (claims.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
        return { ok: false, reason: "password_changed" };
      }
    }

    return {
      ok: true,
      principal: new Principal({
        id: claims.sub,
        role: user?.role ?? claims.role,
        email: user?.email ?? claims.email ?? null,
        tokenId: claims.jti,
        sessionId: claims.sid ?? null,
      }),
      claims,
    };
  }

  /** End one session: deny the access token now, revoke the refresh family. */
  async revoke({ tokenId, expiresAtMs, familyId }) {
    if (tokenId && expiresAtMs) await this.denylist.revoke(tokenId, expiresAtMs);
    if (familyId) await this.sessions.revokeFamily(familyId, new Date(this.clock.now()));
  }

  /** End every session for a user. Used by "log out everywhere". */
  async revokeAllForUser(userId) {
    return this.sessions.revokeAllForUser(userId, new Date(this.clock.now()));
  }

  #signAccess(user) {
    const jti = randomUUID();
    const token = this.signer.sign(
      { sub: user.id, role: user.role, email: user.email, type: "access", jti },
      this.accessTtlMs
    );
    return { token, jti };
  }

  async #mintRefresh(user, { familyId, clientHash, now }) {
    const sessionId = randomUUID();
    const token = this.signer.sign(
      { sub: user.id, type: "refresh", sid: familyId, jti: sessionId },
      this.refreshTtlMs
    );
    const expiresAt = new Date(now + this.refreshTtlMs);

    await this.sessions.save(
      new Session({
        id: sessionId,
        familyId,
        userId: user.id,
        tokenHash: hashToken(token),
        issuedAt: new Date(now).toISOString(),
        expiresAt: expiresAt.toISOString(),
        clientHash,
      })
    );

    return { token, sessionId, expiresAt };
  }
}

/**
 * SHA-256 rather than a password hash.
 *
 * A refresh token is 256+ bits of signed randomness, not a low-entropy human
 * secret, so there is nothing for an offline attacker to brute-force and no
 * reason to pay Argon2id's memory cost on every refresh.
 */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}
