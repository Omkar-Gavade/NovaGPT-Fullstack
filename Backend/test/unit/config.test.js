import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../../src/infrastructure/config/loadConfig.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";

const MINIMAL = { MONGODB_URI: "mongodb://localhost:27017/nova" };

describe("loadConfig", () => {
  test("boots from the minimum viable environment", () => {
    const config = loadConfig(MINIMAL);
    assert.equal(config.env, "development");
    assert.equal(config.http.port, 8080);
    assert.equal(config.redis.enabled, false);
  });

  test("reports every problem at once, not one per restart", () => {
    try {
      loadConfig({ PORT: "not-a-number", LOG_LEVEL: "verbose" });
      assert.fail("expected ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.issues.length, 3); // missing URI + bad port + bad level
      assert.ok(error.issues.some((i) => i.startsWith("MONGODB_URI")));
      assert.ok(error.issues.some((i) => i.startsWith("PORT")));
      assert.ok(error.issues.some((i) => i.startsWith("LOG_LEVEL")));
    }
  });

  test("fails without MONGODB_URI", () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  test("coerces numeric strings, since env values are always strings", () => {
    const config = loadConfig({ ...MINIMAL, PORT: "3000", SHUTDOWN_GRACE_MS: "5000" });
    assert.equal(config.http.port, 3000);
    assert.strictEqual(typeof config.http.port, "number");
    assert.equal(config.shutdown.graceMs, 5000);
  });

  test("rejects an out-of-range port", () => {
    assert.throws(() => loadConfig({ ...MINIMAL, PORT: "99999" }), ConfigError);
  });

  test("wraps credential-bearing values in Secret", () => {
    const config = loadConfig({ ...MINIMAL, REDIS_URL: "redis://user:pass@host:6379" });
    assert.ok(Secret.is(config.mongo.uri));
    assert.ok(Secret.is(config.redis.url));
    assert.equal(config.mongo.uri.expose(), MINIMAL.MONGODB_URI);
    // The whole config object must be safe to log.
    assert.ok(!JSON.stringify(config).includes("pass@host"));
  });

  test("enables redis exactly when a URL is present", () => {
    assert.equal(loadConfig(MINIMAL).redis.enabled, false);
    assert.equal(loadConfig({ ...MINIMAL, REDIS_URL: "redis://h:6379" }).redis.enabled, true);
  });

  test("defaults pretty logging on outside production and off inside it", () => {
    assert.equal(loadConfig(MINIMAL).log.pretty, true);
    assert.equal(loadConfig({ ...MINIMAL, NODE_ENV: "production" }).log.pretty, false);
    // Explicit setting always wins over the environment-derived default.
    assert.equal(
      loadConfig({ ...MINIMAL, NODE_ENV: "production", LOG_PRETTY: "true" }).log.pretty,
      true
    );
  });

  test("parses boolean-ish env values", () => {
    assert.equal(loadConfig({ ...MINIMAL, METRICS_ENABLED: "false" }).metrics.enabled, false);
    assert.equal(loadConfig({ ...MINIMAL, METRICS_ENABLED: "0" }).metrics.enabled, false);
    assert.equal(loadConfig({ ...MINIMAL, METRICS_ENABLED: "1" }).metrics.enabled, true);
    assert.equal(loadConfig({ ...MINIMAL, METRICS_ENABLED: "true" }).metrics.enabled, true);
  });

  test("parses CORS origins as a wildcard or an allowlist", () => {
    assert.equal(loadConfig(MINIMAL).http.corsOrigins, "*");
    assert.deepEqual(
      loadConfig({ ...MINIMAL, CORS_ORIGINS: "https://a.com, https://b.com" }).http.corsOrigins,
      ["https://a.com", "https://b.com"]
    );
  });

  test("parses metric default labels and drops malformed pairs", () => {
    const config = loadConfig({ ...MINIMAL, METRICS_DEFAULT_LABELS: "region=eu,tier=,az=1a" });
    assert.deepEqual(config.metrics.defaultLabels, { region: "eu", az: "1a" });
  });

  test("returns a frozen object, so config cannot be mutated at runtime", () => {
    const config = loadConfig(MINIMAL);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.http));
    assert.throws(() => {
      config.http.port = 1;
    }, TypeError);
  });

  test("does not read process.env when a source is supplied", () => {
    process.env.NOVA_CONFIG_LEAK_CHECK = "leaked";
    const config = loadConfig(MINIMAL);
    assert.equal(config.http.port, 8080);
    delete process.env.NOVA_CONFIG_LEAK_CHECK;
  });
});
