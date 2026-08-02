/**
 * Ordered shutdown.
 *
 * The sequence matters more than any individual step
 * (docs/backend/13-deployment.md#graceful-shutdown):
 *
 *   1. Flip readiness to false.
 *   2. Wait. A load balancer takes seconds to notice a backend has gone
 *      unready. Closing the listener immediately means every request routed
 *      during that window is refused — a deploy that drops traffic while
 *      appearing graceful.
 *   3. Stop accepting new connections; let in-flight requests finish.
 *   4. Close dependencies, once nothing is using them.
 *   5. Exit.
 *
 * Step 2 is the one usually missing, and its absence is invisible in testing
 * because a local deploy has no load balancer to lag behind.
 */
export class GracefulShutdown {
  /**
   * @param {object} deps
   * @param {import("../../domain/lifecycle/ServiceState.js").ServiceState} deps.state
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   * @param {{graceMs: number, drainDelayMs: number}} deps.config
   * @param {Array<{name: string, close: () => Promise<void>}>} deps.resources
   * @param {(code: number) => void} [deps.exit]
   */
  constructor({ state, logger, metrics, config, resources, exit }) {
    this.state = state;
    this.logger = logger.child({ component: "shutdown" });
    this.metrics = metrics;
    this.config = config;
    this.resources = resources;
    this.exit = exit ?? ((code) => process.exit(code));
    this.server = null;
    this.inProgress = null;
  }

  /** @param {import("node:http").Server} server */
  attach(server) {
    this.server = server;
    return this;
  }

  /**
   * Register signal and fatal-error handlers.
   * @returns {() => void} detach, so tests do not leak listeners between cases
   */
  listen() {
    const onSignal = (signal) => () => {
      this.logger.info("shutdown.signal", { signal });
      this.shutdown(0);
    };
    const sigterm = onSignal("SIGTERM");
    const sigint = onSignal("SIGINT");

    // An unhandled rejection or uncaught exception leaves the process in an
    // unknown state. Continuing risks serving corrupted responses, so we exit
    // — but through the drain path, so in-flight requests still complete.
    const onFatal = (kind) => (error) => {
      this.logger.error("process.fatal", { kind, error });
      this.shutdown(1);
    };
    const uncaught = onFatal("uncaughtException");
    const unhandled = onFatal("unhandledRejection");

    process.on("SIGTERM", sigterm);
    process.on("SIGINT", sigint);
    process.on("uncaughtException", uncaught);
    process.on("unhandledRejection", unhandled);

    return () => {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
      process.off("uncaughtException", uncaught);
      process.off("unhandledRejection", unhandled);
    };
  }

  /** Idempotent: a second signal joins the shutdown already running. */
  shutdown(code = 0) {
    this.inProgress ??= this.#run(code);
    return this.inProgress;
  }

  async #run(code) {
    this.state.markDraining();
    this.metrics.setGauge("nova_shutdown_in_progress", 1);
    this.logger.info("shutdown.started", {
      drainDelayMs: this.config.drainDelayMs,
      graceMs: this.config.graceMs,
    });

    // A hard deadline for the whole sequence. Without it, one resource that
    // hangs on close turns a graceful shutdown into a SIGKILL, which is
    // precisely the outcome the sequence exists to avoid.
    const deadline = setTimeout(() => {
      this.logger.warn("shutdown.forced", { reason: "grace period elapsed" });
      this.state.markStopped();
      this.exit(code === 0 ? 1 : code);
    }, this.config.graceMs);
    deadline.unref?.();

    try {
      // Step 2: readiness is already false; give the load balancer time to see it.
      if (this.config.drainDelayMs > 0) await delay(this.config.drainDelayMs);

      // Step 3: stop accepting, finish what is in flight.
      await this.#closeServer();

      // Step 4: dependencies last, so nothing is still using them.
      for (const resource of this.resources) {
        try {
          await resource.close();
          this.logger.info("shutdown.resource_closed", { resource: resource.name });
        } catch (error) {
          // One resource failing to close must not prevent the others from
          // trying — a stuck Redis should not leak a Mongo connection.
          this.logger.warn("shutdown.resource_close_failed", {
            resource: resource.name,
            error,
          });
        }
      }

      clearTimeout(deadline);
      this.state.markStopped();
      this.logger.info("shutdown.complete");
      this.exit(code);
    } catch (error) {
      clearTimeout(deadline);
      this.logger.error("shutdown.failed", { error });
      this.state.markStopped();
      this.exit(1);
    }
  }

  #closeServer() {
    if (!this.server?.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // Idle keep-alive sockets hold `close` open indefinitely because they
      // are connected but not serving a request. Available on Node 18.2+.
      this.server.closeIdleConnections?.();
    });
  }
}

/**
 * Deliberately NOT unref'd.
 *
 * The drain delay must hold the event loop open. Once the listener is the only
 * remaining handle, an unref'd timer lets Node decide there is nothing left to
 * do and exit — mid-drain, before any resource is closed. The result is a
 * process that reports a graceful shutdown while having skipped it entirely.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
