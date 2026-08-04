/**
 * One rate-limit rule, and the decision it produces.
 *
 * Pure. The counting is I/O and lives in the application layer; deciding
 * whether a count is over the line is arithmetic and lives here, where it can
 * be asserted without a Redis.
 *
 * The layers are in docs/backend/10-security.md#rate-limiting and they defend
 * different things — per-IP defends against enumeration and credential
 * stuffing, per-user defends the shared provider quota (T3).
 */

export class RateLimitRule {
  /**
   * @param {object} spec
   * @param {string} spec.name       appears in the metric label and the log
   * @param {number} spec.limit      permitted events per window
   * @param {number} spec.windowMs
   * @param {"ip"|"user"|"global"} spec.scope
   * @param {boolean} [spec.failClosed] deny when the counter store is unavailable
   */
  constructor({ name, limit, windowMs, scope = "ip", failClosed = false }) {
    if (!name) throw new TypeError("A rate-limit rule needs a name");
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new TypeError(`Rate-limit rule ${name} needs a positive limit`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError(`Rate-limit rule ${name} needs a positive window`);
    }

    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
    this.scope = scope;
    this.failClosed = failClosed === true;
    Object.freeze(this);
  }

  /**
   * Sliding-window counter.
   *
   * The estimate is this window's count plus the previous window's count
   * weighted by how much of it still overlaps. A *fixed* window would permit a
   * double burst across the boundary — a full quota at 11:59:59 and another at
   * 12:00:00 — and a token bucket permits bursts we specifically do not want
   * against fixed provider quotas.
   *
   * @param {number} current  events counted in the window containing `now`
   * @param {number} previous events counted in the window before it
   * @param {number} now      epoch milliseconds
   */
  evaluate({ current, previous = 0, now }) {
    const elapsed = now % this.windowMs;
    const carry = previous * (1 - elapsed / this.windowMs);
    const estimate = current + carry;

    if (estimate <= this.limit) {
      return new RateLimitDecision({
        rule: this.name,
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, Math.floor(this.limit - estimate)),
        retryAfterMs: 0,
      });
    }

    return new RateLimitDecision({
      rule: this.name,
      allowed: false,
      limit: this.limit,
      remaining: 0,
      // Wait out the rest of this window. Reporting a shorter delay produces a
      // client that retries into the same rejection, which is worse for both
      // sides than one honest wait.
      retryAfterMs: this.windowMs - elapsed,
    });
  }

  /**
   * The decision to use when the counter store is unreachable.
   *
   * Chat fails **open**: rate limiting protects a resource, and refusing all
   * traffic to protect a quota is a self-inflicted outage worse than the abuse
   * it prevents. Authentication fails **closed**: the thing being protected is
   * credentials, and refusing logins for a few minutes beats permitting
   * unlimited stuffing (docs/backend/10-security.md#rate-limiting).
   */
  onCounterUnavailable() {
    return new RateLimitDecision({
      rule: this.name,
      allowed: !this.failClosed,
      limit: this.limit,
      remaining: 0,
      retryAfterMs: this.failClosed ? this.windowMs : 0,
      degraded: true,
    });
  }
}

export class RateLimitDecision {
  constructor({ rule, allowed, limit, remaining, retryAfterMs, degraded = false }) {
    this.rule = rule;
    this.allowed = allowed;
    this.limit = limit;
    this.remaining = remaining;
    this.retryAfterMs = retryAfterMs;
    this.degraded = degraded;
    Object.freeze(this);
  }

  get retryAfterSeconds() {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}
