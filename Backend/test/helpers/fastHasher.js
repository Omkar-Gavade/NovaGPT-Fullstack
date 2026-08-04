import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A `PasswordHasherPort` implementation with the cost turned down.
 *
 * Argon2id at m=64MB t=3 costs ~80 ms per call by design. A suite that
 * registers and logs in a few hundred times would spend most of its runtime
 * proving a library works, so the tests that care about *hashing* use the real
 * `Argon2Hasher` and everything else uses this.
 *
 * It is a real implementation — salted, derived, constant-time compared — and
 * not a stub returning the password, because a stub would let a test pass while
 * the code under test compared plaintext.
 */
export class FastHasher {
  algorithm = "scrypt-test";

  constructor({ cost = 2 } = {}) {
    this.cost = cost;
  }

  async hash(password) {
    const salt = randomBytes(16);
    const derived = scryptSync(String(password), salt, 32, { N: 1 << this.cost, r: 8, p: 1 });
    return `$test$${this.cost}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  async verify(stored, password) {
    if (typeof stored !== "string") return false;
    const [, tag, cost, salt, expected] = stored.split("$");
    if (tag !== "test") return false;
    try {
      const derived = scryptSync(String(password), Buffer.from(salt, "base64url"), 32, {
        N: 1 << Number(cost),
        r: 8,
        p: 1,
      });
      const target = Buffer.from(expected, "base64url");
      return derived.length === target.length && timingSafeEqual(derived, target);
    } catch {
      return false;
    }
  }

  needsRehash(stored) {
    return typeof stored !== "string" || !stored.startsWith("$test$");
  }
}
