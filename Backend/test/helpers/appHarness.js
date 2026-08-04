import { createApp } from "../../src/interfaces/http/createApp.js";
import { CheckLiveness } from "../../src/application/health/CheckLiveness.js";
import { CheckReadiness } from "../../src/application/health/CheckReadiness.js";
import { GetVersion } from "../../src/application/health/GetVersion.js";
import { ServiceState } from "../../src/domain/lifecycle/ServiceState.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { Metrics } from "../../src/infrastructure/telemetry/Metrics.js";
import { ModelRegistry } from "../../src/infrastructure/providers/catalog/ModelRegistry.js";
import { ProviderRegistry } from "../../src/infrastructure/providers/registry/ProviderRegistry.js";
import { InMemoryThreadRepository } from "../../src/infrastructure/persistence/memory/InMemoryThreadRepository.js";
import { RegistrySnapshotSource } from "../../src/infrastructure/routing/RegistrySnapshotSource.js";
import { ProviderInvoker } from "../../src/infrastructure/routing/ProviderInvoker.js";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { RetryPolicy } from "../../src/domain/routing/RetryPolicy.js";
import { RoutingService } from "../../src/application/routing/RoutingService.js";
import { RoutingExecutor } from "../../src/application/routing/RoutingExecutor.js";
import { StreamingExecutor } from "../../src/application/streaming/StreamingExecutor.js";
import { ChatOrchestrator } from "../../src/application/chat/ChatOrchestrator.js";
import { StreamRegistry } from "../../src/application/chat/StreamRegistry.js";
import { ThreadService } from "../../src/application/threads/ThreadService.js";
import { CatalogService } from "../../src/application/catalog/CatalogService.js";
import { costTable } from "../../src/infrastructure/providers/catalog/CostTable.js";
import { testConfig, recordingLogger, fakeProbe } from "./testDoubles.js";
import { buildMockProvider } from "./mockProvider.js";
import { InMemoryCache } from "../../src/infrastructure/cache/memory/InMemoryCache.js";
import { JwtSigner } from "../../src/infrastructure/security/JwtSigner.js";
import { TokenDenylist } from "../../src/infrastructure/security/TokenDenylist.js";
import {
  InMemoryUserRepository,
  InMemorySessionRepository,
  InMemoryAuditLog,
} from "../../src/infrastructure/persistence/memory/InMemoryIdentityRepositories.js";
import { TokenService } from "../../src/application/identity/TokenService.js";
import { AuthService } from "../../src/application/identity/AuthService.js";
import { RateLimiter, buildRules } from "../../src/application/security/RateLimiter.js";
import { LockoutPolicy } from "../../src/domain/identity/LockoutPolicy.js";
import { FastHasher } from "./fastHasher.js";
import { InMemoryUsageRepository } from "../../src/infrastructure/persistence/memory/InMemoryUsageRepository.js";
import { UsageRecorder } from "../../src/application/usage/UsageRecorder.js";
import { Tracer, LogSpanExporter } from "../../src/infrastructure/telemetry/Tracer.js";
import { SamplingPolicy } from "../../src/domain/observability/SamplingPolicy.js";

/**
 * One RSA key pair for the whole test process.
 *
 * Generating 2048-bit keys costs ~100 ms, and a suite starts a dozen apps. The
 * pair is what production reads from configuration, so sharing it here is the
 * *more* faithful arrangement, not a shortcut.
 */
const KEYS = JwtSigner.generateKeyPair();

/**
 * The whole application on an ephemeral port, with real everything except the
 * provider and the database.
 *
 * Real Express, real middleware chain, real controllers, real orchestrator,
 * real routing and context engines. Only the provider (mock adapter) and the
 * store (in-process repository) are substituted — and both are *real
 * implementations of their ports*, not stubs, so what these tests exercise is
 * the production code path.
 *
 * Requests go over a real socket via `fetch`, so header handling, status codes,
 * and SSE framing are the ones a browser would see.
 */
/**
 * @param {object} [options]
 * @param {boolean} [options.retainTelemetry] keep every log line and every
 *   sampled trace in memory for assertions. On by default, because that is what
 *   most tests are for — and **off for load tests**, where retaining thousands
 *   of span trees would mean the heap assertion measures the harness rather
 *   than the server it is supposed to be watching.
 */
export async function startApp({
  providers,
  config: overrides,
  persistence,
  hasher,
  retainTelemetry = true,
} = {}) {
  const clock = new SystemClock();
  const logger = retainTelemetry ? recordingLogger("debug") : recordingLogger("silent");
  const metrics = new Metrics({ collectDefaults: false, logger });
  const config = testConfig({
    persistence: { inMemory: true },
    routing: {
      maxCandidates: 3,
      maxAttempts: 3,
      maxRetriesPerProvider: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 4,
      attemptTimeoutMs: 5000,
      overallTimeoutMs: 30_000,
      priorities: {},
    },
    ...overrides,
  });

  const modelRegistry = new ModelRegistry();
  const providerRegistry = new ProviderRegistry({ clock, logger, modelRegistry });
  for (const provider of providers ?? [buildMockProvider()]) providerRegistry.register(provider);

  const threads = persistence ?? new InMemoryThreadRepository({ clock });
  const retryPolicy = new RetryPolicy({ baseDelayMs: 1, maxDelayMs: 4 });

  const routingService = new RoutingService({
    policy: new RoutingPolicy(),
    modelRegistry,
    snapshotSource: new RegistrySnapshotSource({ registry: providerRegistry, clock }),
    logger,
    metrics,
    clock,
  });

  const streamRegistry = new StreamRegistry({ clock, metrics });

  const traces = [];
  const tracer = new Tracer({
    clock,
    exporter: {
      export: (trace) => {
        if (retainTelemetry) {
          traces.push(trace);
          new LogSpanExporter({ logger }).export(trace);
        }
      },
    },
    // Every trace is kept under test. Sampling would make span assertions
    // intermittently empty, which is the worst kind of flaky test.
    policy: new SamplingPolicy({ normalRate: 1 }),
    metrics,
  });

  const usageRepository = new InMemoryUsageRepository({ clock });
  const usageRecorder = new UsageRecorder({
    usage: usageRepository,
    costTable,
    clock,
    logger,
    metrics,
  });

  /* ---- security, wired exactly as the composition root does ---- */
  const cache = new InMemoryCache({ clock });
  const users = new InMemoryUserRepository({ clock });
  const sessions = new InMemorySessionRepository({ clock });
  const audit = new InMemoryAuditLog({ clock });

  const signer = new JwtSigner({
    privateKey: KEYS.privateKey,
    publicKey: KEYS.publicKey,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    clock,
  });

  const tokenService = new TokenService({
    signer,
    sessions,
    denylist: new TokenDenylist({ cache, clock }),
    clock,
    logger,
    config: config.auth,
  });

  const authService = new AuthService({
    users,
    tokens: tokenService,
    hasher: hasher ?? new FastHasher(),
    audit,
    lockoutPolicy: new LockoutPolicy(config.auth.lockout),
    clock,
    logger,
    metrics,
    passwordPolicy: config.auth.password,
    allowRegistration: config.auth.allowRegistration,
  });

  const security = {
    tokenService,
    authService,
    users,
    sessions,
    audit,
    limiter: new RateLimiter({ cache, clock, metrics, logger }),
    rules: buildRules(config.rateLimit),
    signer,
  };

  const services = {
    chat: new ChatOrchestrator({
      threads,
      routingService,
      routingExecutor: new RoutingExecutor({
        retryPolicy,
        invoker: new ProviderInvoker({ clock, logger, attemptTimeoutMs: 5000 }),
        registry: providerRegistry,
        clock,
        logger,
        metrics,
        usageRecorder,
        tracer,
      }),
      streamingExecutor: new StreamingExecutor({
        retryPolicy,
        registry: providerRegistry,
        clock,
        logger,
        metrics,
        usageRecorder,
        tracer,
        firstTokenTimeoutMs: 2000,
        interTokenTimeoutMs: 2000,
      }),
      streamRegistry,
      clock,
      logger,
      metrics,
      tracer,
      logContent: config.log.content === true,
    }),
    threads: new ThreadService({ threads, clock, logger }),
    catalog: new CatalogService({ modelRegistry, providerRegistry, costTable }),
  };

  const state = new ServiceState(clock.now());
  state.markReady();

  const useCases = {
    checkLiveness: new CheckLiveness({ state, clock }),
    checkReadiness: new CheckReadiness({
      state,
      probes: [fakeProbe({ name: "threads", critical: true, ok: true })],
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

  const app = createApp({ config, logger, metrics, clock, tracer, useCases, services, security });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * A signed-in account, created on first use.
   *
   * Every request below carries its token unless a test opts out with
   * `{ anonymous: true }` or supplies its own. That means the existing suites
   * exercise the routes as production serves them — guarded — instead of an
   * unprotected variant that would prove nothing about the deployed system.
   */
  // Memoises the **promise**, not the result. Awaiting first and assigning
  // afterwards means ten concurrent requests all see `null`, all register, and
  // nine of them get a duplicate-email conflict — which is a harness race that
  // reads exactly like a product bug.
  let defaultUser = null;
  const signIn = async (email = "harness@novagpt.test") => {
    const result = await authService.register({ email, password: "harness-password-1" });
    return { user: result.user, token: result.tokens.accessToken, tokens: result.tokens };
  };
  const defaultPrincipal = () => {
    defaultUser ??= signIn();
    return defaultUser;
  };
  const defaultToken = async () => (await defaultPrincipal()).token;

  const authHeaders = async ({ anonymous = false, token } = {}) => {
    if (anonymous) return {};
    const bearer = token ?? (await defaultToken());
    return { Authorization: `Bearer ${bearer}` };
  };

  return {
    base,
    server,
    logger,
    metrics,
    threads,
    streamRegistry,
    providerRegistry,
    users,
    sessions,
    audit,
    usage: usageRepository,
    tracer,
    traces,
    authService,
    tokenService,
    cache,
    signIn,
    /** The account every unqualified request in this app runs as. */
    principal: () => defaultPrincipal(),

    async json(path, { anonymous, token, headers, ...init } = {}) {
      const response = await fetch(`${base}${path}`, {
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders({ anonymous, token })),
          ...headers,
        },
        ...init,
      });
      const body = await response.json().catch(() => null);
      return { response, body, status: response.status };
    },

    async post(path, payload, init) {
      return this.json(path, { method: "POST", body: JSON.stringify(payload), ...init });
    },

    /** Read an SSE response into parsed events. */
    async sse(path, payload, { signal, anonymous, token } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders({ anonymous, token })),
        },
        body: JSON.stringify(payload),
        signal,
      });

      const events = [];
      if (!response.body) return { response, events };

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue; // keep-alive comment
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* malformed frame — the client would skip it too */
          }
        }
      }
      return { response, events };
    },

    close: () =>
      new Promise((resolve) => {
        streamRegistry.stopAll();
        server.closeIdleConnections?.();
        server.close(resolve);
      }),
  };
}
