import { RateLimitRule } from "../../domain/security/RateLimitRule.js";

/**
 * Counts events and asks the rules whether that is too many.
 *
 * The split is deliberate: counting is I/O and lives here, deciding is
 * arithmetic and lives in `RateLimitRule`. It means every threshold, every
 * boundary and every fail-open/fail-closed choice is unit-testable without a
 * Redis, and this class only has to be right about keys and windows.
 *
 * **Counters are shared through the cache**, so limits are fleet-wide when
 * Redis is present and per-instance when it is not — the documented degradation
 * (docs/backend/08-storage.md#redis-must-be-optional-and-what-that-costs). The
 * per-instance fallback is weaker, not absent, which is the point.
 */
export class RateLimiter {
  /**
   * @param {object} deps
   * @param {import("../../domain/ports/CachePort.js").CachePort} deps.cache
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {object} [deps.metrics]
   * @param {object} [deps.logger]
   */
  constructor({ cache, clock, metrics, logger, prefix = "rl:" }) {
    this.cache = cache;
    this.clock = clock;
    this.metrics = metrics;
    this.logger = logger?.child?.({ component: "rate-limit" }) ?? logger;
    this.prefix = prefix;
  }

  /**
   * @param {RateLimitRule} rule
   * @param {string} subject the IP, the user id, or a fixed key for a global rule
   */
  async check(rule, subject) {
    const now = this.clock.now();
    const window = Math.floor(now / rule.windowMs);
    const key = (index) => `${this.prefix}${rule.name}:${subject}:${index}`;

    // Held for two windows: the sliding estimate needs the previous window's
    // total to still be readable while the current one fills.
    const current = await this.cache.increment(key(window), rule.windowMs * 2);

    if (current === null) {
      const decision = rule.onCounterUnavailable();
      this.logger?.warn("rate_limit.counter_unavailable", {
        rule: rule.name,
        allowed: decision.allowed,
      });
      this.#record(rule, decision);
      return decision;
    }

    const previous = Number(await this.cache.get(key(window - 1))) || 0;
    const decision = rule.evaluate({ current, previous, now });
    this.#record(rule, decision);
    return decision;
  }

  /**
   * Evaluate several rules and return the first refusal.
   *
   * Short-circuits: once one layer has refused, incrementing the others would
   * charge a request that never ran against limits it never used.
   */
  async checkAll(pairs) {
    for (const { rule, subject } of pairs) {
      const decision = await this.check(rule, subject);
      if (!decision.allowed) return decision;
    }
    return null;
  }

  #record(rule, decision) {
    if (decision.allowed) return;
    this.metrics?.increment("nova_rate_limited_total", {
      rule: rule.name,
      degraded: String(decision.degraded),
    });
  }
}

/**
 * The rule set, built from configuration.
 *
 * The layers are the ones in docs/backend/10-security.md#rate-limiting, and
 * they defend different things — per-IP against enumeration and credential
 * stuffing, per-user against quota exhaustion (T3). One layer is not a subset
 * of another, which is why all of them exist.
 */
export function buildRules(config) {
  return {
    anonymous: new RateLimitRule({
      name: "anonymous_ip",
      limit: config.anonymousPerMinute,
      windowMs: 60_000,
      scope: "ip",
    }),
    // Fail-closed: the resource being protected here is credentials, and
    // refusing logins for a few minutes beats permitting unlimited stuffing.
    auth: new RateLimitRule({
      name: "auth_ip",
      limit: config.authPerMinute,
      windowMs: 60_000,
      scope: "ip",
      failClosed: true,
    }),
    // Fail-open: refusing all chat to protect a quota is a self-inflicted
    // outage worse than the abuse it prevents.
    chatMinute: new RateLimitRule({
      name: "chat_user_minute",
      limit: config.chatPerMinute,
      windowMs: 60_000,
      scope: "user",
    }),
    chatHour: new RateLimitRule({
      name: "chat_user_hour",
      limit: config.chatPerHour,
      windowMs: 3_600_000,
      scope: "user",
    }),
    // Tools and embeddings. Tighter than chat because the provider pools behind
    // them are smaller, and because an embeddings call batches up to 100 inputs
    // — one request is not one unit of work.
    capability: new RateLimitRule({
      name: "capability_user_minute",
      limit: config.capabilityPerMinute ?? 10,
      windowMs: 60_000,
      scope: "user",
    }),
    // Vision draws on the smallest pool of all, and an image is the most
    // expensive thing a user can send.
    vision: new RateLimitRule({
      name: "vision_user_minute",
      limit: config.visionPerMinute ?? 10,
      windowMs: 60_000,
      scope: "user",
    }),
  };
}
