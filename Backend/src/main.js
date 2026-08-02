import "dotenv/config";
import { loadConfig, ConfigError } from "./infrastructure/config/loadConfig.js";
import { buildContainer } from "./container.js";

/**
 * Process bootstrap.
 *
 * Together with `container.js`, the only module permitted to read
 * `process.env` (docs/backend/02-architecture.md#enforcement).
 *
 * Ordering here encodes the availability contract: configuration is validated
 * first and fails the process if it is wrong, then the HTTP server starts, and
 * only then are dependencies connected — in the background. A dependency
 * outage must never prevent the process from listening
 * (docs/backend/13-deployment.md#degradation-matrix).
 */
export async function bootstrap() {
  /* 1. Configuration. A bad value must fail here, loudly, at deploy time —
   *    never inside a request at 3am. */
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Written directly rather than logged: the logger is configured from the
      // config we just failed to load.
      process.stderr.write(`\n${error.message}\n\n`);
      process.stderr.write("Copy Backend/.env.example to Backend/.env and fill it in.\n\n");
      process.exit(1);
    }
    throw error;
  }

  const container = buildContainer(config);
  const { logger, state, mongo, cache, providerManager, app, shutdown } = container;

  logger.info("boot.starting", {
    commit: config.service.commit,
    node: process.versions.node,
    metricsEnabled: config.metrics.enabled,
    cache: cache.kind,
  });

  /* 2. Listen. Before dependencies, so `/live` answers immediately and a slow
   *    or unavailable database cannot look like a crashed process. */
  const server = await listen(app, config.http);
  server.requestTimeout = config.http.requestTimeoutMs;
  // Must exceed the load balancer's idle timeout, or Node closes a connection
  // the balancer still considers usable and the client sees a random 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const detach = shutdown.attach(server).listen();

  /* 3. Dependencies, in the background. Neither call is awaited: both retry on
   *    their own, and readiness reports the truth until they succeed. */
  mongo.start();
  await cache.start?.();

  /* 3b. Provider framework. Awaited because discovery is filesystem work that
   *     finishes in milliseconds, and a fleet whose composition is still
   *     settling would make the first routing decision non-deterministic.
   *     A provider that cannot load degrades the fleet; it never fails boot. */
  const providers = await providerManager.start();

  /* 4. Accept traffic. Readiness still gates on the dependency probes, so this
   *    only means "startup finished", not "everything is healthy". */
  state.markReady();
  logger.info("boot.ready", {
    address: `http://${config.http.host}:${server.address().port}`,
    providers: providers.registered,
    providersSkipped: providers.skipped.length,
  });

  return { ...container, server, detach };
}

function listen(app, http) {
  return new Promise((resolve, reject) => {
    const server = app.listen(http.port, http.host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

// Only self-start when executed directly. Importing this module in a test must
// not bind a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    process.stderr.write(`Failed to start: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
