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
import { RoutingPolicy } from "./domain/routing/RoutingPolicy.js";
import { RetryPolicy } from "./domain/routing/RetryPolicy.js";
import { RegistrySnapshotSource } from "./infrastructure/routing/RegistrySnapshotSource.js";
import { ProviderInvoker } from "./infrastructure/routing/ProviderInvoker.js";
import { RoutingService } from "./application/routing/RoutingService.js";
import { RoutingExecutor } from "./application/routing/RoutingExecutor.js";
import { StreamingExecutor } from "./application/streaming/StreamingExecutor.js";
import { MongoThreadRepository } from "./infrastructure/persistence/mongo/MongoThreadRepository.js";
import { InMemoryThreadRepository } from "./infrastructure/persistence/memory/InMemoryThreadRepository.js";
import { ChatOrchestrator } from "./application/chat/ChatOrchestrator.js";
import { StreamRegistry } from "./application/chat/StreamRegistry.js";
import { ThreadService } from "./application/threads/ThreadService.js";
import { CatalogService } from "./application/catalog/CatalogService.js";
import { costTable } from "./infrastructure/providers/catalog/CostTable.js";
import { JwtSigner } from "./infrastructure/security/JwtSigner.js";
import { Argon2Hasher } from "./infrastructure/security/Argon2Hasher.js";
import { TokenDenylist } from "./infrastructure/security/TokenDenylist.js";
import { EnvelopeCipher } from "./infrastructure/security/EnvelopeCipher.js";
import { MongoUserRepository } from "./infrastructure/persistence/mongo/MongoUserRepository.js";
import { MongoSessionRepository } from "./infrastructure/persistence/mongo/MongoSessionRepository.js";
import { MongoAuditLog } from "./infrastructure/persistence/mongo/MongoAuditLog.js";
import {
  InMemoryUserRepository,
  InMemorySessionRepository,
  InMemoryAuditLog,
} from "./infrastructure/persistence/memory/InMemoryIdentityRepositories.js";
import { TokenService } from "./application/identity/TokenService.js";
import { AuthService } from "./application/identity/AuthService.js";
import { RateLimiter, buildRules } from "./application/security/RateLimiter.js";
import { LockoutPolicy } from "./domain/identity/LockoutPolicy.js";
import { MongoUsageRepository } from "./infrastructure/persistence/mongo/MongoUsageRepository.js";
import { InMemoryUsageRepository } from "./infrastructure/persistence/memory/InMemoryUsageRepository.js";
import { UsageRecorder } from "./application/usage/UsageRecorder.js";
import { PromotionService } from "./application/providers/PromotionService.js";
import { UserKeyService } from "./application/identity/UserKeyService.js";
import { MongoUserKeyRepository } from "./infrastructure/persistence/mongo/MongoUserKeyRepository.js";
import { InMemoryUserKeyRepository } from "./infrastructure/persistence/memory/InMemoryUserKeyRepository.js";
import { Tracer, LogSpanExporter, nullTracer } from "./infrastructure/telemetry/Tracer.js";
import { SamplingPolicy } from "./domain/observability/SamplingPolicy.js";

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

  // Tail-based sampling: the decision is made when the root span ends, so the
  // traces that turn out to matter — errors, failovers, slow requests — are the
  // ones kept (docs/backend/11-observability.md#sampling).
  const tracer = config.tracing.enabled
    ? new Tracer({
        clock,
        exporter: new LogSpanExporter({ logger }),
        policy: new SamplingPolicy({
          normalRate: config.tracing.sampleRate,
          slowThresholdMs: config.tracing.slowThresholdMs,
        }),
        metrics,
        maxSpansPerTrace: config.tracing.maxSpansPerTrace,
      })
    : nullTracer;

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

  /* ---- routing ----
   * The policy is pure and takes a snapshot as an argument; the executor is
   * effectful and owns retry/failover; the invoker owns deadlines and abort.
   * Splitting them this way is what keeps every routing decision unit-testable
   * (docs/backend/04-router.md#what-the-router-is).
   */
  const routingPolicy = new RoutingPolicy({ maxCandidates: config.routing.maxCandidates });
  const retryPolicy = new RetryPolicy({
    maxRetriesPerProvider: config.routing.maxRetriesPerProvider,
    maxAttempts: config.routing.maxAttempts,
    baseDelayMs: config.routing.retryBaseDelayMs,
    maxDelayMs: config.routing.retryMaxDelayMs,
  });
  const snapshotSource = new RegistrySnapshotSource({
    registry: providerRegistry,
    clock,
    priorities: config.routing.priorities,
    // Ranked last until promoted, so a new provider earns traffic rather than
    // being handed it (docs/backend/03-provider-system.md#provider-onboarding-process).
    dark: config.providers.dark,
  });
  const routingService = new RoutingService({
    policy: routingPolicy,
    modelRegistry,
    snapshotSource,
    logger,
    metrics,
    clock,
  });
  /* ---- accounting ----
   * One record per provider attempt, priced at the moment it was incurred.
   * Wired into both executors rather than the orchestrator, because only the
   * executors see the attempts that *failed*
   * (docs/backend/11-observability.md#cost-monitoring).
   */
  const usageRepository = config.persistence.inMemory
    ? new InMemoryUsageRepository({ clock })
    : new MongoUsageRepository({ connection: mongo, logger, clock });

  const usageRecorder = new UsageRecorder({
    usage: usageRepository,
    costTable,
    clock,
    logger,
    metrics,
  });

  const routingExecutor = new RoutingExecutor({
    retryPolicy,
    invoker: new ProviderInvoker({
      clock,
      logger,
      attemptTimeoutMs: config.routing.attemptTimeoutMs,
    }),
    registry: providerRegistry,
    clock,
    logger,
    metrics,
    usageRecorder,
    tracer,
    overallTimeoutMs: config.routing.overallTimeoutMs,
  });

  const streamingExecutor = new StreamingExecutor({
    retryPolicy,
    registry: providerRegistry,
    clock,
    logger,
    metrics,
    usageRecorder,
    tracer,
    overallTimeoutMs: config.routing.overallTimeoutMs,
  });

  /* ---- persistence ----
   * Mongo in production; the in-process implementation is a real
   * implementation of the same port, used by tests and by a local run with no
   * database (docs/backend/08-storage.md).
   */
  const threadRepository = config.persistence.inMemory
    ? new InMemoryThreadRepository({ clock })
    : new MongoThreadRepository({ connection: mongo, logger, clock });

  if (config.persistence.inMemory) {
    logger.warn("persistence.using_memory", {
      impact: "conversations are lost when the process exits; never use in production",
    });
  }

  /* ---- identity and security ----
   * Wired here so no use case ever constructs a signer or reads a key
   * (docs/backend/10-security.md#authentication).
   */
  const userRepository = config.persistence.inMemory
    ? new InMemoryUserRepository({ clock })
    : new MongoUserRepository({ connection: mongo, logger, clock });
  const sessionRepository = config.persistence.inMemory
    ? new InMemorySessionRepository({ clock })
    : new MongoSessionRepository({ connection: mongo, logger, clock });
  const auditLog = config.persistence.inMemory
    ? new InMemoryAuditLog({ clock })
    : new MongoAuditLog({ connection: mongo, logger, clock });

  // Production requires configured keys — `loadConfig` refuses to boot without
  // them. Outside production an ephemeral pair keeps `npm run dev` to one
  // command, at the stated cost: tokens do not survive a restart and cannot be
  // verified by a second instance.
  const keys = config.auth.privateKey
    ? { privateKey: config.auth.privateKey.expose(), publicKey: config.auth.publicKey }
    : JwtSigner.generateKeyPair();
  if (!config.auth.privateKey) {
    logger.warn("auth.ephemeral_signing_key", {
      impact: "every token is invalidated on restart and is not valid on another instance",
      fix: "set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY",
    });
  }
  // Content logging is an operator action, not a setting. Recorded in the audit
  // log at boot so "who turned this on, and when?" has an answer that does not
  // depend on someone remembering
  // (docs/backend/11-observability.md#what-is-never-logged).
  if (config.log.content) {
    logger.warn("logging.content_enabled", {
      impact: "prompts and completions are written to the log pipeline",
      fix: "unset LOG_CONTENT",
    });
    auditLog.append({
      action: "config.content_logging_enabled",
      outcome: "success",
      actorId: null,
      resourceType: "config",
      resourceId: "LOG_CONTENT",
      metadata: { env: config.env, service: config.service.version },
    });
  }

  if (!config.auth.required) {
    logger.warn("auth.not_required", {
      impact: "unauthenticated callers have full access to conversation endpoints",
      fix: "set AUTH_REQUIRED=true",
    });
  }

  const tokenSigner = new JwtSigner({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    previousPublicKeys: config.auth.previousPublicKey ? [config.auth.previousPublicKey] : [],
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    clock,
  });

  const tokenService = new TokenService({
    signer: tokenSigner,
    sessions: sessionRepository,
    denylist: new TokenDenylist({ cache, clock }),
    clock,
    logger,
    config: config.auth,
  });

  const authService = new AuthService({
    users: userRepository,
    tokens: tokenService,
    hasher: new Argon2Hasher(),
    audit: auditLog,
    lockoutPolicy: new LockoutPolicy(config.auth.lockout),
    clock,
    logger,
    metrics,
    passwordPolicy: config.auth.password,
    allowRegistration: config.auth.allowRegistration,
  });

  const rateLimiter = new RateLimiter({ cache, clock, metrics, logger });

  // Only built when a master key is configured. Constructing one with a
  // generated key would encrypt user secrets under a key that dies with the
  // process, which is worse than refusing the feature.
  const envelopeCipher = config.auth.encryptionKey
    ? new EnvelopeCipher({ masterKey: config.auth.encryptionKey.expose() })
    : null;

  const promotionService = new PromotionService({
    usage: usageRepository,
    registry: providerRegistry,
    clock,
    logger,
    darkSince: config.providers.darkSince,
  });

  if (config.providers.dark.length) {
    logger.info("providers.dark", {
      providers: config.providers.dark,
      impact: "ranked last; they receive traffic only as a late failover",
    });
  }

  // BYOK. Only usable when a master key is configured — `UserKeyService`
  // refuses rather than silently falling back, because encrypting user
  // credentials under a key that dies with the process would be worse than not
  // offering the feature (docs/backend/10-security.md#envelope-encryption-for-user-keys).
  const userKeyRepository = config.persistence.inMemory
    ? new InMemoryUserKeyRepository({ clock })
    : new MongoUserKeyRepository({ connection: mongo, logger, clock });

  const userKeyService = new UserKeyService({
    keys: userKeyRepository,
    cipher: envelopeCipher,
    registry: providerRegistry,
    clock,
    logger,
    audit: auditLog,
  });

  if (!envelopeCipher) {
    logger.info("user_keys.disabled", {
      reason: "ENCRYPTION_MASTER_KEY is not set",
      impact: "every request runs on the platform credential",
    });
  }

  const security = {
    tokenService,
    authService,
    users: userRepository,
    sessions: sessionRepository,
    audit: auditLog,
    limiter: rateLimiter,
    rules: buildRules(config.rateLimit),
    signer: tokenSigner,
    envelopeCipher,
    userKeyService,
  };

  /* ---- product services ---- */
  const streamRegistry = new StreamRegistry({ clock, metrics });

  const services = {
    chat: new ChatOrchestrator({
      threads: threadRepository,
      routingService,
      routingExecutor,
      streamingExecutor,
      streamRegistry,
      clock,
      logger,
      metrics,
      tracer,
      logContent: config.log.content,
      userKeys: userKeyService,
    }),
    threads: new ThreadService({ threads: threadRepository, clock, logger }),
    catalog: new CatalogService({
      modelRegistry,
      providerRegistry,
      costTable,
    }),
  };

  /* ---- use cases ---- */

  const useCases = {
    checkLiveness: new CheckLiveness({ state, clock }),
    checkReadiness: new CheckReadiness({
      state,
      // Anything implementing HealthProbePort. Readiness does not know, and
      // must not know, what these are — adding a dependency later means adding
      // it to this array and nothing else.
      //
      // Mongo appears only when it is the store in use: probing it while the
      // in-process repository is serving would report the instance unready over
      // a dependency nothing is talking to.
      probes: [...(config.persistence.inMemory ? [] : [mongo]), cache],
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

  const app = createApp({ config, logger, metrics, clock, tracer, useCases, services, security });

  // Closed in this order at shutdown: the cache first because it is the
  // cheapest to lose, Mongo last because an in-flight write should be given
  // every chance to land.
  const shutdown = new GracefulShutdown({
    state,
    logger,
    metrics,
    config: config.shutdown,
    resources: [
      // In-flight streams first: they hold provider connections open, so
      // nothing below can close cleanly until they are done.
      //
      // Given most of the grace period rather than all of it. A generation that
      // was seconds from finishing should finish; one that would outlast the
      // deploy is aborted so the rest of the sequence still has room to run.
      {
        name: "streams",
        close: async () => {
          const result = await streamRegistry.drain(Math.floor(config.shutdown.graceMs * 0.6));
          logger.info("shutdown.streams_drained", result);
        },
      },
      // Providers next: stopping the health monitor and draining them means
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
    tracer,
    mongo,
    cache,
    modelRegistry,
    providerRegistry,
    providerManager,
    promotionService,
    routingPolicy,
    retryPolicy,
    routingService,
    routingExecutor,
    streamingExecutor,
    threadRepository,
    userKeyRepository,
    userKeyService,
    usageRepository,
    usageRecorder,
    userRepository,
    sessionRepository,
    auditLog,
    streamRegistry,
    security,
    services,
    useCases,
    app,
    shutdown,
  };
}
