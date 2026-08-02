import mongoose from "mongoose";

/**
 * MongoDB connection lifecycle, implementing HealthProbePort.
 *
 * Connects in the background with backoff and never blocks startup.
 *
 * That is the single most important property in this file. The degradation
 * matrix promises that a database outage leaves stateless routes serving
 * (docs/backend/13-deployment.md#degradation-matrix) — a blocking connect would
 * mean a Mongo blip prevents the process from listening at all, turning a
 * degraded dependency into a total outage. The HTTP server comes up
 * immediately; readiness reports the truth; the connection heals on its own.
 */
export class MongoConnection {
  name = "mongodb";
  /** Readiness fails without it: conversations cannot be read or written. */
  critical = true;

  /**
   * @param {object} deps
   * @param {import("../../config/loadConfig.js").Config["mongo"]} deps.config
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {typeof mongoose} [deps.client] injectable for tests
   */
  constructor({ config, logger, clock, client = mongoose }) {
    this.config = config;
    this.logger = logger.child({ component: "mongo" });
    this.clock = clock;
    this.client = client;
    this.attempts = 0;
    this.stopped = false;
    this.retryTimer = null;
    this.connectedAt = null;
  }

  /** True once the driver reports an established connection. */
  get isConnected() {
    return this.client.connection?.readyState === 1;
  }

  /** Fire-and-forget. Deliberately returns before the connection is up. */
  start() {
    this.stopped = false;
    this.#connect();
  }

  async #connect() {
    if (this.stopped) return;
    this.attempts += 1;
    try {
      await this.client.connect(this.config.uri.expose(), {
        serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMs,
        maxPoolSize: this.config.maxPoolSize,
      });
      this.connectedAt = this.clock.now();
      this.logger.info("mongo.connected", { attempts: this.attempts });
      this.attempts = 0;
    } catch (error) {
      if (this.stopped) return;
      // Capped exponential backoff. Uncapped, a long outage pushes the retry
      // interval past the point where recovery is noticed in reasonable time.
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
      this.logger.warn("mongo.connect_failed", {
        attempt: this.attempts,
        retryInMs: delay,
        error,
      });
      this.retryTimer = setTimeout(() => this.#connect(), delay);
      // Do not hold the event loop open purely to retry a connection.
      this.retryTimer.unref?.();
    }
  }

  /**
   * Liveness probe. `ping` rather than `readyState` because a socket can be
   * open to a server that is no longer answering.
   */
  async probe() {
    const started = this.clock.now();
    if (!this.isConnected) {
      return {
        name: this.name,
        critical: this.critical,
        ok: false,
        latencyMs: 0,
        detail: "not connected",
      };
    }
    try {
      await this.client.connection.db.admin().ping();
      return {
        name: this.name,
        critical: this.critical,
        ok: true,
        latencyMs: this.clock.now() - started,
      };
    } catch (error) {
      return {
        name: this.name,
        critical: this.critical,
        ok: false,
        latencyMs: this.clock.now() - started,
        // The message is surfaced to operators, so it is scrubbed of anything
        // that could carry a host or credential.
        detail: "ping failed",
        error,
      };
    }
  }

  async close() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.client.connection?.readyState !== 0) {
      await this.client.disconnect();
      this.logger.info("mongo.disconnected");
    }
  }
}
