import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CheckLiveness } from "../../src/application/health/CheckLiveness.js";
import { CheckReadiness } from "../../src/application/health/CheckReadiness.js";
import { GetVersion } from "../../src/application/health/GetVersion.js";
import { ServiceState, Phase } from "../../src/domain/lifecycle/ServiceState.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";
import { fakeProbe, recordingMetrics } from "../helpers/testDoubles.js";

function ready() {
  const state = new ServiceState(0);
  state.markReady();
  return state;
}

describe("CheckLiveness", () => {
  test("is alive while starting, before any dependency is connected", () => {
    // Liveness must never depend on a dependency: probing Mongo here would let
    // a database blip restart every healthy instance at once.
    const result = new CheckLiveness({ state: new ServiceState(0), clock: new FakeClock(500) }).execute();
    assert.equal(result.alive, true);
    assert.equal(result.phase, Phase.STARTING);
    assert.equal(result.uptimeMs, 500);
  });

  test("stays alive while draining", () => {
    const state = ready();
    state.markDraining();
    const result = new CheckLiveness({ state, clock: new FakeClock(0) }).execute();
    assert.equal(result.alive, true, "a draining process must not be SIGKILLed");
  });

  test("is not alive once stopped", () => {
    const state = ready();
    state.markDraining();
    state.markStopped();
    assert.equal(new CheckLiveness({ state, clock: new FakeClock(0) }).execute().alive, false);
  });
});

describe("CheckReadiness", () => {
  const clock = () => new FakeClock(0);

  test("is ready when every dependency is up", async () => {
    const result = await new CheckReadiness({
      state: ready(),
      probes: [fakeProbe({ name: "mongodb", critical: true }), fakeProbe({ name: "cache" })],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, true);
    assert.equal(result.reason, null);
    assert.equal(result.dependencies.length, 2);
  });

  test("is not ready when a critical dependency is down", async () => {
    const result = await new CheckReadiness({
      state: ready(),
      probes: [fakeProbe({ name: "mongodb", critical: true, ok: false })],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, false);
    assert.match(result.reason, /mongodb/);
  });

  test("stays ready but reports degraded when a non-critical dependency is down", async () => {
    // Redis down must not remove every instance from the load balancer
    // (docs/backend/13-deployment.md#degradation-matrix).
    const result = await new CheckReadiness({
      state: ready(),
      probes: [
        fakeProbe({ name: "mongodb", critical: true, ok: true }),
        fakeProbe({ name: "redis", critical: false, ok: false }),
      ],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, true);
    assert.match(result.reason, /degraded: redis/);
  });

  test("is not ready while still starting, whatever the dependencies say", async () => {
    const result = await new CheckReadiness({
      state: new ServiceState(0),
      probes: [fakeProbe({ name: "mongodb", critical: true, ok: true })],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, false);
    assert.equal(result.reason, "starting up");
  });

  test("is not ready while draining, and skips probing entirely", async () => {
    // The ordering that makes zero-downtime deploys work: out of rotation
    // first, socket closed second.
    const state = ready();
    state.markDraining();
    let probed = false;
    const result = await new CheckReadiness({
      state,
      probes: [
        {
          name: "mongodb",
          critical: true,
          probe: async () => {
            probed = true;
            return { name: "mongodb", critical: true, ok: true, latencyMs: 0 };
          },
        },
      ],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, false);
    assert.equal(result.reason, "shutting down");
    assert.equal(probed, false);
  });

  test("times out a hanging probe rather than hanging itself", async () => {
    const result = await new CheckReadiness({
      state: ready(),
      probes: [fakeProbe({ name: "slow", critical: true, delayMs: 5000 })],
      clock: clock(),
      metrics: recordingMetrics(),
      probeTimeoutMs: 20,
    }).execute();
    assert.equal(result.ready, false);
    assert.equal(result.dependencies[0].detail, "probe timed out");
  });

  test("treats a throwing probe as down instead of propagating", async () => {
    const result = await new CheckReadiness({
      state: ready(),
      probes: [fakeProbe({ name: "broken", critical: true, throws: true })],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.equal(result.ready, false);
    assert.equal(result.dependencies[0].ok, false);
  });

  test("probes in parallel, so latency is the slowest not the sum", async () => {
    const started = Date.now();
    await new CheckReadiness({
      state: ready(),
      probes: [
        fakeProbe({ name: "a", delayMs: 40 }),
        fakeProbe({ name: "b", delayMs: 40 }),
        fakeProbe({ name: "c", delayMs: 40 }),
      ],
      clock: clock(),
      metrics: recordingMetrics(),
    }).execute();
    assert.ok(Date.now() - started < 110, "probes must run concurrently");
  });

  test("records a gauge and a duration per dependency", async () => {
    const metrics = recordingMetrics();
    await new CheckReadiness({
      state: ready(),
      probes: [fakeProbe({ name: "mongodb", critical: true }), fakeProbe({ name: "redis", ok: false })],
      clock: clock(),
      metrics,
    }).execute();
    assert.deepEqual(
      metrics.calls.setGauge.map((c) => [c.labels.dependency, c.value]),
      [["mongodb", 1], ["redis", 0]]
    );
    assert.equal(metrics.calls.observe.length, 2);
  });
});

describe("GetVersion", () => {
  test("reports build identity and uptime", () => {
    const state = new ServiceState(1000);
    const result = new GetVersion({
      service: { name: "nova", version: "1.2.3", commit: "abc1234", builtAt: "2026-01-01T00:00:00Z" },
      state,
      clock: new FakeClock(4000),
      environment: "production",
      runtime: "node test",
    }).execute();
    assert.equal(result.version, "1.2.3");
    assert.equal(result.commit, "abc1234");
    assert.equal(result.environment, "production");
    assert.equal(result.uptimeMs, 3000);
    assert.ok(result.runtime.startsWith("node "));
  });

  test("reports no configuration, only build metadata", () => {
    const result = new GetVersion({
      service: { name: "nova", version: "1.0.0", commit: "x", builtAt: null },
      state: new ServiceState(0),
      clock: new FakeClock(0),
      environment: "production",
      runtime: "node test",
    }).execute();
    // Dependency URLs and provider inventory are operational intelligence.
    const keys = Object.keys(result);
    for (const leaky of ["mongo", "redis", "config", "providers", "env"]) {
      assert.ok(!keys.includes(leaky), `must not expose ${leaky}`);
    }
  });
});
