import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { RetryPolicy, SwitchPolicy } from "../../src/domain/routing/RetryPolicy.js";
import { RoutingService } from "../../src/application/routing/RoutingService.js";
import { RoutingExecutor } from "../../src/application/routing/RoutingExecutor.js";
import { ProviderInvoker } from "../../src/infrastructure/routing/ProviderInvoker.js";
import { RegistrySnapshotSource } from "../../src/infrastructure/routing/RegistrySnapshotSource.js";
import { ProviderRegistry } from "../../src/infrastructure/providers/registry/ProviderRegistry.js";
import { ModelRegistry } from "../../src/infrastructure/providers/catalog/ModelRegistry.js";
import { ProviderPhase } from "../../src/domain/provider/ProviderState.js";
import { CancelledError } from "../../src/domain/errors/index.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { recordingLogger, recordingMetrics } from "../helpers/testDoubles.js";
import { buildMockProvider } from "../helpers/mockProvider.js";
import { Adapter, descriptor as mockDescriptor } from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * The routing engine driven end to end against real provider instances.
 *
 * Uses the mock adapter, so retry and failover are exercised with real
 * scripting and zero network. A real clock is used deliberately: backoff delays
 * are part of what is under test, so the retry base is set to ~1ms rather than
 * faked away.
 */

/** A second mock provider under a different id, so failover has a destination. */
function buildSecondProvider(id = "mock-b", settings = {}) {
  const descriptor = new ProviderDescriptor({
    ...mockDescriptor,
    id,
    name: `Mock ${id}`,
    models: mockDescriptor.models.map((m) => ({ ...m, id: `${id}-${m.id}` })),
  });
  return new Adapter({
    descriptor,
    models: descriptor.models.map((m) => new ModelDescriptor({ ...m, provider: id })),
    logger: silentLogger,
    clock: new SystemClock(),
    credential: new Secret("enabled", "MOCK_PROVIDER_ENABLED"),
    settings,
  });
}

function build({ providers, retry = {}, overallTimeoutMs = 120_000, attemptTimeoutMs = 5000 } = {}) {
  const clock = new SystemClock();
  const logger = recordingLogger();
  const metrics = recordingMetrics();
  const modelRegistry = new ModelRegistry();
  const registry = new ProviderRegistry({ clock, logger, modelRegistry });

  for (const provider of providers) registry.register(provider);

  const service = new RoutingService({
    policy: new RoutingPolicy(),
    modelRegistry,
    snapshotSource: new RegistrySnapshotSource({ registry, clock }),
    logger,
    metrics,
    clock,
  });

  const executor = new RoutingExecutor({
    retryPolicy: new RetryPolicy({ baseDelayMs: 1, maxDelayMs: 4, ...retry }),
    invoker: new ProviderInvoker({ clock, logger, attemptTimeoutMs }),
    registry,
    clock,
    logger,
    metrics,
    overallTimeoutMs,
  });

  return { service, executor, registry, modelRegistry, logger, metrics, clock };
}

const generate = (provider, model, options) =>
  provider.generate([{ role: "user", content: "hello" }], options);

describe("routing execution — the happy path", () => {
  test("routes, invokes, and records the outcome", async () => {
    const { service, executor, registry, metrics } = build({ providers: [buildMockProvider()] });

    const { decision } = service.route({});
    const outcome = await executor.execute({ decision, invoke: generate });

    assert.equal(outcome.result.text, "mock response");
    assert.equal(outcome.provider, "mock");
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.switched, null);
    assert.equal(registry.state("mock").phase, ProviderPhase.HEALTHY);
    assert.ok(metrics.calls.increment.some((c) => c.name === "nova_routing_decisions_total"));
  });

  test("a successful attempt feeds latency back into ranking", async () => {
    const { service, executor, registry } = build({
      providers: [buildMockProvider({ latencyMs: 20 })],
    });
    const { decision } = service.route({});
    await executor.execute({ decision, invoke: generate });
    assert.ok(registry.averageLatencyMs("mock") >= 15, "measured latency must be recorded");
  });
});

describe("routing execution — retry against the same provider", () => {
  test("retries a transient failure and succeeds without failing over", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "timeout" }, { text: "recovered" }]);
    const { service, executor, logger, metrics } = build({ providers: [provider] });

    const { decision } = service.route({});
    const outcome = await executor.execute({ decision, invoke: generate });

    assert.equal(outcome.result.text, "recovered");
    assert.equal(outcome.attempts.length, 2);
    assert.equal(outcome.provider, "mock", "same provider — no failover occurred");
    assert.equal(outcome.switched, null);
    assert.equal(logger.find("routing.retry").length, 1);
    assert.ok(metrics.calls.increment.some((c) => c.name === "nova_routing_retries_total"));
  });

  test("stops retrying at the per-provider limit", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "timeout" }, { fail: "timeout" }, { fail: "timeout" }]);
    const { service, executor } = build({
      providers: [provider],
      retry: { maxRetriesPerProvider: 1, maxAttempts: 5 },
    });

    const { decision } = service.route({});
    await assert.rejects(() => executor.execute({ decision, invoke: generate }));
    // One initial attempt plus exactly one retry.
    assert.equal(provider.calls.length, 2);
  });

  test("does not retry a quota failure — it is a fact, not a blip", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "quota" }, { text: "would have worked" }]);
    const { service, executor, logger } = build({ providers: [provider] });

    const { decision } = service.route({});
    await assert.rejects(() => executor.execute({ decision, invoke: generate }));
    assert.equal(provider.calls.length, 1, "a second attempt would be guaranteed waste");
    assert.equal(logger.find("routing.retry").length, 0);
  });

  test("honours Retry-After over the computed backoff", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "rate_limit", retryAfter: 0.05 }, { text: "ok" }]);
    const { service, executor, logger } = build({ providers: [provider] });

    const started = Date.now();
    const { decision } = service.route({});
    await executor.execute({ decision, invoke: generate });

    assert.ok(Date.now() - started >= 45, "must wait what the provider asked for");
    assert.equal(logger.find("routing.retry")[0].delayMs, 50);
  });
});

describe("routing execution — failover to another provider", () => {
  test("fails over on quota and reports the switch", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();

    const { service, executor, logger, metrics } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});
    assert.equal(decision.primary.provider, "mock");

    const outcome = await executor.execute({ decision, invoke: generate });

    assert.equal(outcome.provider, "mock-b");
    assert.ok(outcome.switched, "failover is never silent");
    assert.equal(outcome.switched.from.provider, "mock");
    assert.equal(outcome.switched.to.provider, "mock-b");
    assert.equal(outcome.switched.reason, "quota");
    assert.match(outcome.switched.message, /reached its quota/);
    assert.equal(logger.find("routing.failover").length, 1);
    assert.ok(metrics.calls.increment.some((c) => c.name === "nova_routing_failovers_total"));
  });

  test("retries first, then fails over — in that order", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "timeout" }, { fail: "timeout" }, { fail: "timeout" }]);
    const secondary = buildSecondProvider();

    const { service, executor, logger } = build({
      providers: [primary, secondary],
      retry: { maxRetriesPerProvider: 1, maxAttempts: 4 },
    });
    const { decision } = service.route({});
    const outcome = await executor.execute({ decision, invoke: generate });

    assert.equal(primary.calls.length, 2, "one attempt plus one retry before switching");
    assert.equal(outcome.provider, "mock-b");
    assert.equal(logger.find("routing.retry").length, 1);
    assert.equal(logger.find("routing.failover").length, 1);
  });

  test("never fails over on api_error", async () => {
    // The request was rejected; a second provider would fail identically.
    const primary = buildMockProvider();
    primary.script([{ fail: "api_error" }]);
    const secondary = buildSecondProvider();

    const { service, executor, logger } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});

    await assert.rejects(() => executor.execute({ decision, invoke: generate }));
    assert.equal(secondary.calls.length, 0, "the second provider must never be tried");
    assert.equal(logger.find("routing.failover").length, 0);
  });

  test("the failed provider's breaker opens and it leaves rotation", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();

    const { service, executor, registry } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});
    await executor.execute({ decision, invoke: generate });

    assert.equal(registry.isAvailable("mock"), false);
    // The next request routes straight to the survivor, with no wasted attempt.
    const { decision: next } = service.route({});
    assert.equal(next.primary.provider, "mock-b");
  });

  test("exhausting every provider reports each one tried", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();
    secondary.script([{ fail: "outage" }, { fail: "outage" }, { fail: "outage" }]);

    const { service, executor, logger } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});

    await assert.rejects(
      () => executor.execute({ decision, invoke: generate }),
      (error) => {
        // One message with the full diagnostic beats only the last failure.
        assert.deepEqual(error.details.tried, ["mock", "mock-b"]);
        assert.ok(error.details.attempts.length >= 2);
        return true;
      }
    );
    assert.equal(logger.find("routing.attempts_exhausted").length, 1);
  });
});

describe("routing execution — switch policies", () => {
  test("never: surfaces the error instead of switching", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();

    const { service, executor } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});

    await assert.rejects(() =>
      executor.execute({ decision, invoke: generate, switchPolicy: SwitchPolicy.NEVER })
    );
    assert.equal(secondary.calls.length, 0);
  });

  test("ask: surfaces a proposal naming the suggested alternative", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();

    const { service, executor } = build({ providers: [primary, secondary] });
    const { decision } = service.route({});

    await assert.rejects(
      () => executor.execute({ decision, invoke: generate, switchPolicy: SwitchPolicy.ASK }),
      (error) => {
        assert.equal(error.requiresConfirmation, true);
        assert.equal(error.suggestion.provider, "mock-b");
        return true;
      }
    );
    assert.equal(secondary.calls.length, 0, "nothing is switched without confirmation");
  });
});

describe("routing execution — timeouts and cancellation", () => {
  test("a slow provider hits the attempt timeout and is classed as timeout", async () => {
    const provider = buildMockProvider();
    provider.script([{ delayMs: 5000 }, { text: "second attempt" }]);
    const { service, executor } = build({ providers: [provider], attemptTimeoutMs: 40 });

    const { decision } = service.route({});
    const outcome = await executor.execute({ decision, invoke: generate });

    assert.equal(outcome.attempts[0].kind, "timeout");
    assert.equal(outcome.result.text, "second attempt", "timeout is retryable");
  });

  test("the overall budget bounds the whole chain, not just one attempt", async () => {
    const provider = buildMockProvider();
    provider.script([{ delayMs: 5000 }, { delayMs: 5000 }, { delayMs: 5000 }]);
    const { service, executor } = build({
      providers: [provider],
      attemptTimeoutMs: 60,
      overallTimeoutMs: 90,
    });

    const started = Date.now();
    const { decision } = service.route({});
    await assert.rejects(() => executor.execute({ decision, invoke: generate }));
    // Must fail cleanly well inside the budget rather than running attempts out.
    assert.ok(Date.now() - started < 400, "aggregate budget must bound the chain");
  });

  test("cancellation stops immediately and is not a provider failure", async () => {
    const provider = buildMockProvider();
    provider.script([{ delayMs: 5000 }]);
    const secondary = buildSecondProvider();
    const { service, executor, registry } = build({ providers: [provider, secondary] });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const { decision } = service.route({});
    await assert.rejects(
      () => executor.execute({ decision, invoke: generate, signal: controller.signal }),
      (error) => CancelledError.is(error)
    );

    // A user cancelling must not take a healthy provider out for everyone.
    assert.notEqual(registry.state("mock").phase, ProviderPhase.OPEN);
    assert.equal(secondary.calls.length, 0, "cancellation must not fail over");
  });
});

describe("routing execution — no provider-specific knowledge", () => {
  test("the executor works with any provider id, unchanged", async () => {
    // Nothing in the routing path names a provider; swapping ids is enough.
    const a = buildSecondProvider("acme");
    const b = buildSecondProvider("globex");
    a.script([{ fail: "outage" }, { fail: "outage" }, { fail: "outage" }]);

    const { service, executor } = build({ providers: [a, b], retry: { maxRetriesPerProvider: 0 } });
    const { decision } = service.route({});
    const outcome = await executor.execute({ decision, invoke: generate });

    assert.ok(["acme", "globex"].includes(outcome.provider));
    assert.equal(outcome.result.text, "mock response");
  });
});
