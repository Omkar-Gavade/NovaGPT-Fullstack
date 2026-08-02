import { ServiceState } from "./domain/lifecycle/ServiceState.js";
import { Logger } from "./infrastructure/telemetry/Logger.js";
import { Metrics, nullMetrics } from "./infrastructure/telemetry/Metrics.js";
import { SystemClock } from "./infrastructure/system/SystemClock.js";
import { MongoConnection } from "./infrastructure/persistence/mongo/MongoConnection.js";
import { createCache } from "./infrastructure/cache/createCache.js";
import { GracefulShutdown } from "./infrastructure/system/GracefulShutdown.js";
import { CheckLiveness } from "./application/health/CheckLiveness.js";
import { CheckReadiness } from "./application/health/CheckReadiness.js";
import { GetVersion } from "./application/health/GetVersion.js";
import { createApp } from "./interfaces/http/createApp.js";
import { ModelRegistry } from "./infrastructure/providers/catalog/ModelRegistry.js";
import { ProviderRegistry } from "./infrastructure/providers/registry/ProviderRegistry.js";
import { ProviderDiscovery } from "./infrastructure/providers/registry/ProviderDiscovery.js";
import { ProviderLoader } from "./infrastructure/providers/registry/ProviderLoader.js";
import { ProviderFactory } from "./infrastructure/providers/registry/ProviderFactory.js";
import { ProviderHealthManager } from "./infrastructure/providers/health/ProviderHealthManager.js";
import { ProviderManager } from "./application/providers/ProviderManager.js";

/**
 * The composition root.
 *
 * The one place in the codebase that knows about every layer at once. Nothing
 * else calls `new MongoConnection()` or reads configuration directly — which is
 * what makes the dependency rule enforceable rather than aspirational
 * (docs/backend/02-architecture.md#the-composition-root).
 *
 * Hand-written rather than a DI framework. The wiring below is explicit enough
 * to read top to bottom and debug with a breakpoint; a container with
 * decorators and reflection would solve a problem this codebase does not have
 * (docs/backend/16-repository-structure.md#composition-root).
 */
export function buildContainer(config) {
  const clock = new SystemClock();
  const state = new ServiceState(clock.now());

  const logger = new Logger({
    level: config.log.level,
    pretty: config.log.pretty,
    base: {
      service: config.service.name,
      version: config.service.version,
      env: config.env,
    },
  });

  const metrics = config.metrics.enabled
    ? new Metrics({
        defaultLabels: config.metrics.defaultLabels,
        // Default collection registers process-wide collectors, which throw on
        // a duplicate registration. Skipped under test so suites can build
        // containers freely.
        collectDefaults: !config.isTest,
        logger,
      })
    : nullMetrics;

  /* ---- driven adapters ---- */

  const mongo = new MongoConnection({ config: config.mongo, logger, clock });
  const cache = createCache({ config, logger, clock });

  /* ---- provider framework ----
   * Assembled here, started by main.js. Each piece has one job and none of
   * them knows the sequence; ProviderManager owns that
   * (docs/backend/03-provider-system.md).
   */
  const modelRegistry = new ModelRegistry();
  const providerRegistry = new ProviderRegistry({
    clock,
    logger,
    modelRegistry,
    failureThreshold: config.providers.failureThreshold,
  });
  const providerManager = new ProviderManager({
    discovery: new ProviderDiscovery({ logger }),
    loader: new ProviderLoader({ logger }),
    factory: new ProviderFactory({
      policy: { allowlist: config.providers.allowlist, denylist: config.providers.denylist },
      // The factory receives the environment rather than reading it, so the
      // whole fleet can be constructed with fake credentials in a test.
      env: process.env,
      logger,
      clock,
    }),
    registry: providerRegistry,
    health: new ProviderHealthManager({
      registry: providerRegistry,
      clock,
      logger,
      metrics,
      intervalMs: config.providers.healthIntervalMs,
      probeTimeoutMs: config.providers.probeTimeoutMs,
    }),
    logger,
  });

  /* ---- use cases ---- */

  const useCases = {
    checkLiveness: new CheckLiveness({ state, clock }),
    checkReadiness: new CheckReadiness({
      state,
      // Anything implementing HealthProbePort. Readiness does not know, and
      // must not know, what these are — adding a dependency later means adding
      // it to this array and nothing else.
      probes: [mongo, cache],
      clock,
      metrics,
    }),
    getVersion: new GetVersion({
      service: config.service,
      state,
      clock,
      environment: config.env,
      runtime: `node ${process.versions.node}`,
    }),
  };

  /* ---- driving adapters ---- */

  const app = createApp({ config, logger, metrics, clock, useCases });

  // Closed in this order at shutdown: the cache first because it is the
  // cheapest to lose, Mongo last because an in-flight write should be given
  // every chance to land.
  const shutdown = new GracefulShutdown({
    state,
    logger,
    metrics,
    config: config.shutdown,
    resources: [
      // Providers first: stopping the health monitor and draining them means
      // no new upstream work is started while the rest closes.
      { name: "providers", close: () => providerManager.stop() },
      { name: "cache", close: () => cache.close() },
      { name: "mongo", close: () => mongo.close() },
    ],
  });

  return {
    config,
    clock,
    state,
    logger,
    metrics,
    mongo,
    cache,
    modelRegistry,
    providerRegistry,
    providerManager,
    useCases,
    app,
    shutdown,
  };
}
