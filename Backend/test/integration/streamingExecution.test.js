import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StreamingExecutor } from "../../src/application/streaming/StreamingExecutor.js";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { RetryPolicy, SwitchPolicy } from "../../src/domain/routing/RetryPolicy.js";
import { RoutingService } from "../../src/application/routing/RoutingService.js";
import { RegistrySnapshotSource } from "../../src/infrastructure/routing/RegistrySnapshotSource.js";
import { ProviderRegistry } from "../../src/infrastructure/providers/registry/ProviderRegistry.js";
import { ModelRegistry } from "../../src/infrastructure/providers/catalog/ModelRegistry.js";
import { StreamEventType } from "../../src/domain/streaming/StreamEvent.js";
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
 * Streaming driven end to end through the routing chain.
 *
 * The cases here are the ones that only exist because output has already
 * reached the client: buffer resets, switch ordering, and the ban on retrying
 * a stream in place.
 */

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

function build({ providers, retry = {}, timeouts = {} }) {
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

  const executor = new StreamingExecutor({
    retryPolicy: new RetryPolicy({ baseDelayMs: 1, maxDelayMs: 4, ...retry }),
    registry,
    clock,
    logger,
    metrics,
    firstTokenTimeoutMs: 500,
    interTokenTimeoutMs: 500,
    ...timeouts,
  });

  return { service, executor, registry, logger, metrics };
}

const streamInvoke = (provider, model, options) =>
  provider.stream([{ role: "user", content: "hello" }], options);

async function drain(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const textOf = (events) =>
  events
    .filter((e) => e.type === StreamEventType.DELTA)
    .map((e) => e.text)
    .join("");

describe("streaming execution — the happy path", () => {
  test("streams to completion and records success", async () => {
    const { service, executor, registry, metrics } = build({ providers: [buildMockProvider()] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));

    assert.equal(events[0].type, StreamEventType.START);
    assert.equal(events.at(-1).type, StreamEventType.DONE);
    assert.equal(textOf(events), "mock response");
    assert.equal(registry.state("mock").phase, ProviderPhase.HEALTHY);
    assert.ok(metrics.calls.observe.some((c) => c.name === "nova_stream_ttft_seconds"));
  });

  test("exactly one terminal event ends the stream", async () => {
    const { service, executor } = build({ providers: [buildMockProvider()] });
    const { decision } = service.route({ streaming: true });
    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));

    const terminals = events.filter(
      (e) => e.type === StreamEventType.DONE || e.type === StreamEventType.ERROR
    );
    assert.equal(terminals.length, 1, "neither leaves the client with an unresolvable spinner");
  });

  test("an empty stream is treated as an outage, never a blank success", async () => {
    // Silent quota exhaustion frequently manifests as an empty 200. Retries are
    // disabled here so the classification is what is under test rather than the
    // recovery — with retries on, an empty stream is retried and may succeed.
    const provider = buildMockProvider();
    provider.script([{ emptyStream: true }]);
    const { service, executor, logger } = build({
      providers: [provider],
      retry: { maxRetriesPerProvider: 0 },
    });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    assert.equal(events.at(-1).type, StreamEventType.ERROR);
    assert.equal(logger.find("streaming.attempt_failed")[0].kind, "outage");
  });

  test("a failed attempt never emits a terminal event to the client", async () => {
    // A `done` forwarded before the attempt is validated lets the client
    // finalise the message and then receive a second `start`.
    const provider = buildMockProvider();
    provider.script([{ emptyStream: true }, { text: "recovered" }]);
    const { service, executor } = build({ providers: [provider] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    const terminals = events.filter(
      (e) => e.type === StreamEventType.DONE || e.type === StreamEventType.ERROR
    );
    assert.equal(terminals.length, 1, "exactly one terminal, even across a retry");
    assert.equal(textOf(events), "recovered");
  });
});

describe("streaming execution — mid-stream failure", () => {
  test("fails over and never concatenates two models' output", async () => {
    // The single most important streaming rule: without the buffer reset the
    // client sees "The capital of The capital of France is Paris."
    const primary = buildMockProvider({ defaultText: "one two three four five" });
    primary.script([{ failAfterChunks: 2 }]);
    const secondary = buildSecondProvider("mock-b", { defaultText: "complete answer here" });

    const { service, executor } = build({ providers: [primary, secondary] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    const switched = events.find((e) => e.type === StreamEventType.SWITCHED);

    assert.ok(switched, "failover is never silent");
    assert.equal(switched.discardPartial, true, "the client must clear its partial render");

    // The switch arrives before any of the replacement's tokens.
    const switchIndex = events.indexOf(switched);
    const deltasAfter = events
      .slice(switchIndex + 1)
      .filter((e) => e.type === StreamEventType.DELTA)
      .map((e) => e.text)
      .join("");
    assert.equal(deltasAfter, "complete answer here");
    assert.equal(events.at(-1).type, StreamEventType.DONE);
  });

  test("a stream that emitted content is never retried in place", async () => {
    // The client already has those tokens; replaying would duplicate them.
    const primary = buildMockProvider({ defaultText: "aa bb cc dd" });
    primary.script([{ failAfterChunks: 2, failMidStreamKind: "timeout" }]);
    const secondary = buildSecondProvider();

    const { service, executor, logger } = build({ providers: [primary, secondary] });
    const { decision } = service.route({ streaming: true });
    await drain(executor.stream({ decision, invoke: streamInvoke }));

    // timeout is normally retryable, but not once content is out.
    assert.equal(logger.find("routing.retry").length, 0);
    const attempt = logger.find("streaming.attempt_failed")[0];
    assert.equal(attempt.action, "failover");
  });

  test("a failure before the first token is retried in place", async () => {
    // Nothing has reached the client, so the cheap option is still available.
    const provider = buildMockProvider();
    provider.script([{ fail: "timeout" }, { text: "second attempt" }]);
    const { service, executor, logger } = build({ providers: [provider] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    assert.equal(textOf(events), "second attempt");
    assert.equal(logger.find("streaming.attempt_failed")[0].action, "retry");
    assert.ok(!events.some((e) => e.type === StreamEventType.SWITCHED));
  });

  test("exhausting every provider ends with a terminal error event", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();
    secondary.script([{ fail: "quota" }, { fail: "quota" }, { fail: "quota" }]);

    const { service, executor } = build({ providers: [primary, secondary] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    assert.equal(events.at(-1).type, StreamEventType.ERROR);
    assert.ok(events.at(-1).message);
  });

  test("switchPolicy=never surfaces an error rather than switching", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const secondary = buildSecondProvider();

    const { service, executor } = build({ providers: [primary, secondary] });
    const { decision } = service.route({ streaming: true });

    const events = await drain(
      executor.stream({ decision, invoke: streamInvoke, switchPolicy: SwitchPolicy.NEVER })
    );
    assert.ok(!events.some((e) => e.type === StreamEventType.SWITCHED));
    assert.equal(events.at(-1).type, StreamEventType.ERROR);
    assert.equal(secondary.calls.length, 0);
  });
});

describe("streaming execution — stalls and cancellation", () => {
  test("a stream that never starts hits the first-token timeout", async () => {
    const provider = buildMockProvider();
    provider.script([{ delayMs: 5000 }, { text: "recovered" }]);
    const { service, executor } = build({
      providers: [provider],
      timeouts: { firstTokenTimeoutMs: 40 },
    });
    const { decision } = service.route({ streaming: true });

    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));
    assert.equal(textOf(events), "recovered", "a stall before the first token is retryable");
  });

  test("cancellation stops immediately and is not a provider failure", async () => {
    const provider = buildMockProvider();
    provider.script([{ delayMs: 5000 }]);
    const secondary = buildSecondProvider();
    const { service, executor, registry } = build({ providers: [provider, secondary] });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const { decision } = service.route({ streaming: true });
    await assert.rejects(
      () => drain(executor.stream({ decision, invoke: streamInvoke, signal: controller.signal })),
      (error) => CancelledError.is(error)
    );

    // A user cancelling must not take a healthy provider out for everyone.
    assert.notEqual(registry.state("mock").phase, ProviderPhase.OPEN);
    assert.equal(secondary.calls.length, 0, "cancellation must not fail over");
  });

  test("abandoning the consumer releases the provider's iterator", async () => {
    // A caller that breaks out of `for await` must not leak the upstream reader.
    const provider = buildMockProvider({ defaultText: "a b c d e f g" });
    const { service, executor } = build({ providers: [provider] });
    const { decision } = service.route({ streaming: true });

    let seen = 0;
    for await (const event of executor.stream({ decision, invoke: streamInvoke })) {
      if (event.type === StreamEventType.DELTA && ++seen >= 2) break;
    }
    assert.equal(seen, 2);
  });
});

describe("streaming execution — provider independence", () => {
  test("works with any provider ids, unchanged", async () => {
    const a = buildSecondProvider("acme");
    const b = buildSecondProvider("globex", { defaultText: "from globex" });
    a.script([{ fail: "outage" }, { fail: "outage" }, { fail: "outage" }]);

    const { service, executor } = build({
      providers: [a, b],
      retry: { maxRetriesPerProvider: 0 },
    });
    const { decision } = service.route({ streaming: true });
    const events = await drain(executor.stream({ decision, invoke: streamInvoke }));

    assert.equal(events.at(-1).type, StreamEventType.DONE);
    assert.ok(textOf(events).length > 0);
  });
});
