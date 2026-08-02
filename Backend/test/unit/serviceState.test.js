import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ServiceState, Phase } from "../../src/domain/lifecycle/ServiceState.js";

describe("ServiceState", () => {
  test("starts in the starting phase and is not accepting traffic", () => {
    const state = new ServiceState(1000);
    assert.equal(state.phase, Phase.STARTING);
    assert.ok(state.isAlive);
    assert.ok(!state.isAcceptingTraffic);
  });

  test("accepts traffic once ready", () => {
    const state = new ServiceState(0);
    assert.ok(state.markReady());
    assert.ok(state.isAcceptingTraffic);
  });

  test("stops accepting traffic while draining, but stays alive", () => {
    const state = new ServiceState(0);
    state.markReady();
    state.markDraining();
    assert.ok(!state.isAcceptingTraffic);
    // Still alive: liveness must not fail during a drain, or the orchestrator
    // would SIGKILL the process mid-shutdown.
    assert.ok(state.isAlive);
    assert.ok(state.isShuttingDown);
  });

  test("never returns to ready once draining", () => {
    const state = new ServiceState(0);
    state.markReady();
    state.markDraining();
    assert.equal(state.markReady(), false);
    assert.equal(state.phase, Phase.DRAINING);
  });

  test("is not alive once stopped", () => {
    const state = new ServiceState(0);
    state.markReady();
    state.markDraining();
    state.markStopped();
    assert.ok(!state.isAlive);
  });

  test("ignores a repeated transition instead of throwing", () => {
    // SIGTERM followed by SIGINT must not raise inside a signal handler.
    const state = new ServiceState(0);
    state.markDraining();
    assert.doesNotThrow(() => state.markDraining());
  });

  test("can drain directly from starting", () => {
    const state = new ServiceState(0);
    assert.ok(state.markDraining());
  });

  test("reports uptime from the injected clock reading", () => {
    assert.equal(new ServiceState(1000).uptimeMs(3500), 2500);
  });
});
