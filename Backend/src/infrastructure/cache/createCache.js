import { RedisCache } from "./redis/RedisCache.js";
import { InMemoryCache } from "./memory/InMemoryCache.js";

/**
 * Choose a cache implementation from configuration.
 *
 * The choice is made once, here, and never again. Callers receive a CachePort
 * and cannot tell which one they got — which is what keeps "Redis is optional"
 * from leaking into every call site as a conditional.
 *
 * A deployment running more than one instance MUST configure Redis
 * (docs/backend/15-decisions.md#adr-014--redis-is-required-for-horizontal-scaling);
 * that is an operational requirement, not something this function can enforce,
 * so it is logged loudly instead.
 */
export function createCache({ config, logger, clock }) {
  if (!config.redis.enabled) {
    logger.warn("cache.using_memory", {
      reason: "REDIS_URL not set",
      impact: "rate limits and breaker state are per-instance; do not run more than one instance",
    });
    return new InMemoryCache({ clock });
  }
  return new RedisCache({ config: config.redis, logger, clock });
}
