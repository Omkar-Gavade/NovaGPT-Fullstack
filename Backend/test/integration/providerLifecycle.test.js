import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderManager } from "../../src/application/providers/ProviderManager.js";
import { ProviderDiscovery } from "../../src/infrastructure/providers/registry/ProviderDiscovery.js";
import { ProviderLoader } from "../../src/infrastructure/providers/registry/ProviderLoader.js";
import { ProviderFactory } from "../../src/infrastructure/providers/registry/ProviderFactory.js";
import { ProviderRegistry } from "../../src/infrastructure/providers/registry/ProviderRegistry.js";
import { ProviderHealthManager } from "../../src/infrastructure/providers/health/ProviderHealthManager.js";
import { ModelRegistry } from "../../src/infrastructure/providers/catalog/ModelRegistry.js";
import { ProviderError, FailureKind } from "../../src/domain/errors/ProviderError.js";
import { ProviderPhase } from "../../src/domain/provider/ProviderState.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";
import { recordingLogger, recordingMetrics } from "../helpers/testDoubles.js";
import { buildMockProvider } from "../helpers/mockProvider.js";

/**
 * The full assembly chain, exercised against the real adapters directory.
 *
 * This is the test that proves the headline requirement: adding a provider is
 * "create adapter, register adapter, nothing else". Nothing here names the mock
 * adapter's module path — it is found by scanning `src/.../adapters`, which is
 * the same mechanism a real provider will use.
 */

const ADAPTERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/infrastructure/providers/adapters"
);

function build({ env = { MOCK_PROVIDER_ENABLED: "1" }, policy = {}, providerConfig = {} } = {}) {
  const clock = new FakeClock(0);
  const logger = recordingLogger();
  const metrics = recordingMetrics();
  const modelRegistry = new ModelRegistry();
  const registry = new ProviderRegistry({ clock, logger, modelRegistry });

  const manager = new ProviderManager({
    discovery: new ProviderDiscovery({ directory: ADAPTERS_DIR, logger }),
    loader: new ProviderLoader({ logger }),
    factory: new ProviderFactory({ env, policy, providerConfig, logger, clock }),
    registry,
    health: new ProviderHealthManager({ registry, clock, logger, metrics, intervalMs: 50 }),
    logger,
  });

  return { manager, registry, modelRegistry, clock, logger, metrics };
}

describe("provider lifecycle — discovery through registration", () => {
  test("discovers, loads, constructs and registers an adapter from the filesystem", async () => {
    // No module path is named anywhere in this test. Dropping a folder in is
    // the entire registration step.
    const { manager, registry, modelRegistry } = build();
    const result = await manager.start();

    assert.ok(result.registered.includes("mock"));
    assert.equal(result.failed.length, 0, "every adapter on disk must load cleanly");
    assert.ok(registry.has("mock"));
    assert.ok(modelRegistry.size >= 2, "the adapter contributed its own models");
    await manager.stop();
  });

  test("a provider without its credential is skipped with an actionable reason", async () => {
    const { manager, registry } = build({ env: {} });
    const result = await manager.start();

    assert.equal(result.registered.length, 0);
    // Located by id, not by position: the adapters directory holds every real
    // provider now, and discovery order is filesystem order.
    const mock = result.skipped.find((entry) => entry.id === "mock");
    assert.ok(mock, "the mock adapter must appear among the skipped");
    assert.match(mock.reason, /MOCK_PROVIDER_ENABLED/);
    // Skipped providers stay visible: an absence with a fixable cause must not
    // be silent.
    assert.equal(registry.snapshot().skipped.length, result.skipped.length);
    await manager.stop();
  });

  test("warns loudly when nothing is configured", async () => {
    // Everything downstream will fail in a way that looks like a different
    // problem, so this has to be obvious at boot.
    const { manager, logger } = build({ env: {} });
    await manager.start();
    assert.equal(logger.find("providers.none_configured").length, 1);
    await manager.stop();
  });

  test("an allowlist keeps a provider out entirely", async () => {
    const { manager } = build({ policy: { allowlist: ["something-else"] } });
    const result = await manager.start();
    assert.equal(result.registered.length, 0);
    const mock = result.skipped.find((entry) => entry.id === "mock");
    assert.match(mock.reason, /PROVIDERS_ENABLED/);
    await manager.stop();
  });

  test("adapter settings reach the instance", async () => {
    const { manager } = build({
      providerConfig: { mock: { settings: { defaultText: "configured text" } } },
    });
    await manager.start();
    const provider = manager.get("mock");
    const result = await provider.generate([{ role: "user", content: "x" }], {
      model: "mock-standard",
    });
    assert.equal(result.text, "configured text");
    await manager.stop();
  });

  test("starting twice is idempotent", async () => {
    const { manager, registry } = build();
    await manager.start();
    await manager.start();
    assert.equal(registry.size, 1);
    await manager.stop();
  });
});

describe("provider lifecycle — loader isolation", () => {
  test("one broken adapter does not stop the others loading", async () => {
    // A syntax error in an experimental provider must not take down a platform
    // that was perfectly capable of running without it.
    const logger = recordingLogger();
    const loader = new ProviderLoader({ logger });
    const { loaded, failed } = await loader.loadAll([
      { id: "mock", specifier: path.join(ADAPTERS_DIR, "mock/index.js") },
      { id: "ghost", specifier: path.join(ADAPTERS_DIR, "ghost/index.js") },
    ]);

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].descriptor.id, "mock");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, "ghost");
    assert.equal(logger.find("providers.load.failed").length, 1);
  });

  test("rejects an adapter whose declared id does not match its directory", async () => {
    // Otherwise the config key and the discovered key differ, and the provider
    // can never be enabled by configuration.
    const loader = new ProviderLoader({ logger: recordingLogger() });
    await assert.rejects(
      () => loader.load({ id: "renamed", specifier: path.join(ADAPTERS_DIR, "mock/index.js") }),
      /must match/
    );
  });

  test("discovery returns nothing when the directory is absent", async () => {
    // A deployment may legitimately run with no adapters; the platform still
    // serves health and metrics.
    const logger = recordingLogger();
    const found = await new ProviderDiscovery({ directory: "/nonexistent", logger }).discover();
    assert.deepEqual(found, []);
    assert.equal(logger.find("providers.discovery.no_directory").length, 1);
  });
});

describe("provider lifecycle — health", () => {
  test("a failure opens the breaker and removes the provider from rotation", async () => {
    const { manager, registry, clock } = build();
    await manager.start();

    registry.recordFailure("mock", new ProviderError("quota", FailureKind.QUOTA));
    assert.equal(registry.isAvailable("mock"), false);

    clock.advance(15 * 60_000 + 1);
    assert.equal(registry.isAvailable("mock"), true, "recovers without intervention");
    await manager.stop();
  });

  test("the monitor probes only providers that are not healthy", async () => {
    // Probing a healthy provider is pure waste, and on a free tier it spends a
    // request a user could have had.
    const { manager, registry } = build();
    await manager.start();

    registry.recordSuccess("mock", 10);
    assert.equal(manager.health.suspects().length, 0);

    registry.recordFailure("mock", new ProviderError("slow", FailureKind.TIMEOUT));
    assert.deepEqual(manager.health.suspects().map((p) => p.id), ["mock"]);
    await manager.stop();
  });

  test("a failing probe never opens a breaker", async () => {
    // A flaky probe endpoint must not take a working provider out of rotation.
    const { manager, registry } = build();
    await manager.start();

    registry.recordFailure("mock", new ProviderError("slow", FailureKind.TIMEOUT));
    const phaseBefore = registry.state("mock").phase;
    assert.equal(phaseBefore, ProviderPhase.DEGRADED);

    manager.get("mock").script([{ unhealthy: true }]);
    const result = await manager.health.probe("mock");

    assert.equal(result.ok, false);
    assert.equal(registry.state("mock").phase, phaseBefore, "a probe may only improve state");
    await manager.stop();
  });

  test("a successful probe restores a degraded provider", async () => {
    const { manager, registry, logger } = build();
    await manager.start();

    registry.recordFailure("mock", new ProviderError("slow", FailureKind.TIMEOUT));
    const result = await manager.health.probe("mock");

    assert.equal(result.ok, true);
    assert.equal(registry.state("mock").phase, ProviderPhase.HEALTHY);
    assert.equal(logger.find("providers.health.recovered").length, 1);
    await manager.stop();
  });

  test("records a health gauge per provider", async () => {
    const { manager, metrics } = build();
    await manager.start();
    await manager.health.probe("mock");
    assert.ok(metrics.calls.setGauge.some((c) => c.name === "nova_provider_health"));
    await manager.stop();
  });

  test("probeAll reports every provider", async () => {
    const { manager } = build();
    await manager.start();
    const results = await manager.checkHealth();
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "mock");
    await manager.stop();
  });
});

describe("provider lifecycle — operator control", () => {
  test("disable takes a provider out without unregistering it", async () => {
    const { manager, registry } = build();
    await manager.start();

    assert.ok(manager.disable("mock"));
    assert.equal(registry.isAvailable("mock"), false);
    assert.ok(registry.has("mock"), "in-flight work still has its instance");

    assert.ok(manager.enable("mock"));
    assert.equal(registry.isAvailable("mock"), true);
    await manager.stop();
  });

  test("stop drains every provider and halts the monitor", async () => {
    const { manager, registry } = build();
    await manager.start();
    await manager.stop();

    assert.equal(registry.state("mock").phase, ProviderPhase.DRAINING);
    assert.equal(manager.health.timer, null);
  });

  test("supports registering a provider built outside discovery", async () => {
    const { manager, registry } = build({ env: {} });
    await manager.start();
    assert.equal(registry.size, 0);

    manager.register(buildMockProvider());

    assert.equal(registry.size, 1);
    assert.ok(registry.isAvailable("mock"));
    await manager.stop();
  });
});
