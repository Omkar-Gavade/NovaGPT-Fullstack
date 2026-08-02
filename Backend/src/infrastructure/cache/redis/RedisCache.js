import Redis from "ioredis";

/**
 * Redis-backed cache implementing CachePort.
 *
 * Holds the state that must be shared across instances: rate-limit counters,
 * circuit-breaker state, health snapshots
 * (docs/backend/15-decisions.md#adr-014--redis-is-required-for-horizontal-scaling).
 *
 * Every operation fails soft. Redis being unreachable degrades the platform, it
 * does not break it — so a cache miss and a cache outage are indistinguishable
 * to callers, which is exactly the contract that lets chat keep working when
 * Redis is down.
 */
export class RedisCache {
  kind = "redis";
  name = "redis";
  critical = false;

  /**
   * @param {object} deps
   * @param {import("../../config/loadConfig.js").Config["redis"]} deps.config
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {object} [deps.client] injectable for tests
   */
  constructor({ config, logger, clock, client }) {
    this.config = config;
    this.logger = logger.child({ component: "redis" });
    this.clock = clock;
    this.client =
      client ??
      new Redis(config.url.expose(), {
        connectTimeout: config.connectTimeoutMs,
        keyPrefix: config.keyPrefix,
        // Keep retrying forever with a capped delay: Redis coming back should
        // restore shared state without a restart.
        retryStrategy: (times) => Math.min(2000, times * 200),
        // Fail fast instead of queueing commands while disconnected. A queue
        // would turn a Redis outage into unbounded latency on every caller.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });

    this.client.on?.("error", (error) => {
      // Connection errors are frequent and self-healing during an outage;
      // logging each at error level would drown the log that matters.
      this.logger.warn("redis.error", { error });
    });
    this.client.on?.("ready", () => this.logger.info("redis.ready"));
  }

  async start() {
    try {
      await this.client.connect?.();
    } catch (error) {
      // Startup must not depend on Redis. The retry strategy takes over.
      this.logger.warn("redis.initial_connect_failed", { error });
    }
  }

  async get(key) {
    try {
      const raw = await this.client.get(key);
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (error) {
      this.logger.warn("redis.get_failed", { key, error });
      return null;
    }
  }

  async set(key, value, ttlMs) {
    try {
      const payload = JSON.stringify(value);
      if (ttlMs) await this.client.set(key, payload, "PX", ttlMs);
      else await this.client.set(key, payload);
    } catch (error) {
      this.logger.warn("redis.set_failed", { key, error });
    }
  }

  async del(key) {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn("redis.del_failed", { key, error });
    }
  }

  /**
   * INCR then set the expiry only on first write, so a sustained stream of
   * requests cannot keep pushing the window out and prevent the counter from
   * ever resetting.
   */
  async increment(key, ttlMs) {
    try {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.pexpire(key, ttlMs);
      return count;
    } catch (error) {
      this.logger.warn("redis.incr_failed", { key, error });
      // Reported as the first hit in the window. Failing open is correct for
      // rate limiting: refusing all traffic to protect a limit is a
      // self-inflicted outage worse than the abuse it prevents
      // (docs/backend/10-security.md#rate-limiting).
      return 1;
    }
  }

  async isHealthy() {
    try {
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async probe() {
    const started = this.clock.now();
    const ok = await this.isHealthy();
    return {
      name: this.name,
      critical: this.critical,
      ok,
      latencyMs: this.clock.now() - started,
      detail: ok ? undefined : "unreachable — limits and breakers are per-instance",
    };
  }

  async close() {
    try {
      await this.client.quit();
      this.logger.info("redis.closed");
    } catch {
      this.client.disconnect?.();
    }
  }
}
