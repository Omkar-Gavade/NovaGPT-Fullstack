/**
 * Account lockout after repeated login failures.
 *
 * Pure: given a failure count it returns how long the account is locked. No
 * clock, no storage, no I/O — which is what makes the escalation curve
 * assertable instead of being something that only shows up in production.
 *
 * **Backoff rather than a hard lock.** A permanent lock after N failures hands
 * an attacker a denial-of-service primitive: knowing a victim's email is enough
 * to lock them out indefinitely. Escalating delays make stuffing uneconomic
 * (a thousand guesses take days) while a real user who mistyped waits seconds
 * (docs/backend/10-security.md#authentication).
 */
export class LockoutPolicy {
  /**
   * @param {object} [options]
   * @param {number} [options.threshold] failures before any lock applies
   * @param {number} [options.baseDelayMs] first lock duration
   * @param {number} [options.maxDelayMs] ceiling on the escalation
   */
  constructor({ threshold = 5, baseDelayMs = 30_000, maxDelayMs = 15 * 60_000 } = {}) {
    this.threshold = threshold;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  /** Lock duration for a given consecutive-failure count. 0 means not locked. */
  durationFor(failures) {
    if (failures < this.threshold) return 0;
    const overshoot = failures - this.threshold;
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** overshoot);
  }

  /** @returns {number|null} epoch milliseconds until which the account is locked */
  lockedUntil(failures, now) {
    const duration = this.durationFor(failures);
    return duration ? now + duration : null;
  }
}
