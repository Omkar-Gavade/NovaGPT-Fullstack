import { hash, verify, Algorithm } from "@node-rs/argon2";

/**
 * Argon2id password hashing, implementing `PasswordHasherPort`.
 *
 * **Why Argon2id and not bcrypt.** Argon2id is memory-hard: cracking it
 * requires 64 MB of memory *per guess*, which is what removes the attacker's
 * GPU and ASIC advantage. bcrypt is CPU-hard only, so a rig that would manage
 * thousands of bcrypt guesses per second manages a small fraction of that
 * against Argon2id at these parameters
 * (docs/backend/10-security.md#authentication).
 *
 * The `id` variant specifically: `i` resists side channels but not GPUs, `d`
 * the reverse, `id` is the hybrid and the recommended default.
 *
 * Parameters (m=64MB, t=3, p=4) are the documented ones. They are also a
 * per-login cost *we* pay, which is why the login endpoint is rate limited
 * before it reaches this class — otherwise unauthenticated requests can
 * allocate 64 MB each on demand.
 */
export class Argon2Hasher {
  algorithm = "argon2id";

  /**
   * @param {object} [options]
   * @param {number} [options.memoryCost] KiB
   * @param {number} [options.timeCost] iterations
   * @param {number} [options.parallelism] lanes
   */
  constructor({ memoryCost = 65_536, timeCost = 3, parallelism = 4 } = {}) {
    this.options = {
      algorithm: Algorithm.Argon2id,
      memoryCost,
      timeCost,
      parallelism,
    };
  }

  async hash(password) {
    return hash(password, this.options);
  }

  /**
   * Verification never throws for a wrong password — or for a malformed stored
   * hash. A corrupt row must read as "this password does not match", not as a
   * 500 that tells an attacker the account exists and is in an unusual state.
   */
  async verify(storedHash, password) {
    if (typeof storedHash !== "string" || storedHash.length === 0) return false;
    try {
      return await verify(storedHash, password, this.options);
    } catch {
      return false;
    }
  }

  /**
   * True when a stored hash was produced with weaker parameters than the
   * current ones.
   *
   * Parameters are raised as hardware improves. Without a rehash-on-login path
   * a raise protects only accounts created afterwards, and the oldest accounts
   * — the ones with the most to lose — keep the weakest hashes forever.
   */
  needsRehash(storedHash) {
    if (typeof storedHash !== "string") return true;
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!match) return true;

    const [, memory, time, lanes] = match.map(Number);
    return (
      memory < this.options.memoryCost ||
      time < this.options.timeCost ||
      lanes < this.options.parallelism
    );
  }
}
