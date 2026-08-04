/**
 * Revoked access tokens, keyed by `jti`.
 *
 * Access tokens are stateless and live 15 minutes, which is the whole point:
 * no per-request database lookup. But "log out everywhere" and "this account is
 * compromised" need to take effect *now*, and this is the narrow exception that
 * makes that possible.
 *
 * **Entries expire with the token.** The TTL is the token's own remaining
 * lifetime, so the list never grows beyond the tokens currently live — a
 * denylist that outlives its tokens is an unbounded structure that eventually
 * costs more than the revocation is worth.
 *
 * **A cache outage degrades, it does not break.** Without the cache, revocation
 * is delayed by at most the access-token lifetime and authentication keeps
 * working. Making revocation a hard dependency would make the cache a
 * single point of failure for the entire product, which contradicts
 * "degrade, don't collapse" (docs/backend/10-security.md#authentication).
 */
export class TokenDenylist {
  /**
   * @param {object} deps
   * @param {import("../../domain/ports/CachePort.js").CachePort} deps.cache
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {string} [deps.prefix]
   */
  constructor({ cache, clock, prefix = "auth:denied:" }) {
    this.cache = cache;
    this.clock = clock;
    this.prefix = prefix;
  }

  #key(tokenId) {
    return `${this.prefix}${tokenId}`;
  }

  /**
   * @param {string} tokenId
   * @param {number} expiresAtMs when the token would have expired anyway
   */
  async revoke(tokenId, expiresAtMs) {
    const ttl = Math.max(1000, expiresAtMs - this.clock.now());
    await this.cache.set(this.#key(tokenId), 1, ttl);
  }

  async isRevoked(tokenId) {
    if (!tokenId) return false;
    return (await this.cache.get(this.#key(tokenId))) !== null;
  }
}
