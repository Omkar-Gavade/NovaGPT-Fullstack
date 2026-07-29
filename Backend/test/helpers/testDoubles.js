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
    log: { level: "silent", pretty: false },
    mongo: { serverSelectionTimeoutMs: 100, maxPoolSize: 1 },
    redis: { enabled: false, url: null, connectTimeoutMs: 100, keyPrefix: "test:" },
    metrics: { enabled: true, path: "/api/v1/admin/metrics", defaultLabels: {} },
    shutdown: { graceMs: 1000, drainDelayMs: 0 },
    ...overrides,
  };
}
