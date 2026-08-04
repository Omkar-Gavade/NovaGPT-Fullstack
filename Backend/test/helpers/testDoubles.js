import { Logger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * Test doubles for the ports.
 *
 * Kept beside the tests rather than inside `src/` because they are test
 * infrastructure — but they are shared across suites so that every test
 * exercises the *same* fake, and a fake that drifts per file is how two suites
 * end up asserting incompatible behaviour.
 */

/** Logger that records instead of writing, so log output can be asserted. */
export function recordingLogger(level = "debug") {
  const lines = [];
  const stream = {
    write(text) {
      lines.push(JSON.parse(text));
      return true;
    },
  };
  const logger = new Logger({ level, stream });
  logger.lines = lines;
  logger.find = (event) => lines.filter((l) => l.event === event);
  return logger;
}

/** Metrics double recording every call, with no prom-client involvement. */
export function recordingMetrics() {
  const calls = { increment: [], observe: [], setGauge: [] };
  return {
    calls,
    increment: (name, labels, value = 1) => calls.increment.push({ name, labels, value }),
    observe: (name, value, labels) => calls.observe.push({ name, value, labels }),
    setGauge: (name, value, labels) => calls.setGauge.push({ name, value, labels }),
    render: async () => "",
    contentType: () => "text/plain",
    reset: () => {
      calls.increment.length = 0;
      calls.observe.length = 0;
      calls.setGauge.length = 0;
    },
  };
}

/**
 * A dependency probe with scriptable behaviour.
 * @param {object} options
 * @param {string} options.name
 * @param {boolean} [options.critical]
 * @param {boolean} [options.ok]
 * @param {number} [options.delayMs] simulate a slow or hanging probe
 * @param {boolean} [options.throws]
 */
export function fakeProbe({ name, critical = false, ok = true, delayMs = 0, throws = false }) {
  return {
    name,
    critical,
    async probe() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (throws) throw new Error("probe exploded");
      return { name, critical, ok, latencyMs: delayMs };
    },
  };
}

/** Minimal config for building an app under test. */
export function testConfig(overrides = {}) {
  return {
    env: "test",
    isProduction: false,
    isTest: true,
    service: { name: "nova-test", version: "1.2.3", commit: "abc1234", builtAt: null },
    http: {
      host: "127.0.0.1",
      port: 0,
      publicUrl: null,
      bodyLimit: "1mb",
      requestTimeoutMs: 30_000,
      corsOrigins: "*",
    },
    log: { level: "silent", pretty: false, content: false },
    mongo: { serverSelectionTimeoutMs: 100, maxPoolSize: 1 },
    redis: { enabled: false, url: null, connectTimeoutMs: 100, keyPrefix: "test:" },
    persistence: { inMemory: true },
    attachments: {
      allowedHosts: [], maxBytes: 8 * 1024 * 1024, maxCount: 10,
      maxTotalBytes: 24 * 1024 * 1024, fetchTimeoutMs: 5000,
    },
    providers: { allowlist: null, denylist: [], dark: [], darkSince: {},
                 healthIntervalMs: 60_000, probeTimeoutMs: 8000, failureThreshold: 3 },
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
    metrics: { enabled: true, path: "/api/v1/admin/metrics", defaultLabels: {} },
    auth: {
      // On by default, so the suite exercises the same guarded routes
      // production serves rather than an unprotected variant of them.
      required: true,
      allowRegistration: true,
      issuer: "novagpt-test",
      audience: "novagpt-api",
      accessTtlMs: 900_000,
      refreshTtlMs: 3_600_000,
      privateKey: null,
      publicKey: null,
      previousPublicKey: null,
      cookie: { name: "nova_refresh", domain: null, secure: false },
      password: { minLength: 12 },
      lockout: { threshold: 5, baseDelayMs: 1000, maxDelayMs: 4000 },
      encryptionKey: null,
    },
    // Deliberately far above anything a test sends. A suite that trips a
    // production limit fails for a reason unrelated to what it asserts; the
    // limits themselves are tested directly, with rules built for the purpose.
    rateLimit: {
      anonymousPerMinute: 100_000,
      authPerMinute: 100_000,
      chatPerMinute: 100_000,
      chatPerHour: 100_000,
    },
    shutdown: { graceMs: 1000, drainDelayMs: 0 },
    ...overrides,
  };
}
