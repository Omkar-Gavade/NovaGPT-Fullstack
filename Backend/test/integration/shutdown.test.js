import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GracefulShutdown } from "../../src/infrastructure/system/GracefulShutdown.js";
import { ServiceState, Phase } from "../../src/domain/lifecycle/ServiceState.js";
import { recordingLogger, recordingMetrics } from "../helpers/testDoubles.js";
import { startTestServer } from "../helpers/httpHarness.js";

function build({ resources = [], config = {}, state } = {}) {
  const exits = [];
  const shutdown = new GracefulShutdown({
    state: state ?? readyState(),
    logger: recordingLogger(),
    metrics: recordingMetrics(),
    config: { graceMs: 2000, drainDelayMs: 0, ...config },
    resources,
    exit: (code) => exits.push(code),
  });
  return { shutdown, exits };
}

function readyState() {
  const state = new ServiceState(Date.now());
  state.markReady();
  return state;
}

describe("GracefulShutdown", () => {
  test("drains, closes resources in order, then exits zero", async () => {
    const closed = [];
    const state = readyState();
    const { shutdown, exits } = build({
      state,
      resources: [
        { name: "cache", close: async () => closed.push("cache") },
        { name: "mongo", close: async () => closed.push("mongo") },
      ],
    });

    await shutdown.shutdown(0);

    assert.deepEqual(closed, ["cache", "mongo"], "cheapest to lose closes first");
    assert.equal(state.phase, Phase.STOPPED);
    assert.deepEqual(exits, [0]);
  });

  test("stops accepting traffic before anything is closed", async () => {
    // The ordering that makes a zero-downtime deploy possible: a load balancer
    // must see 503 on /ready before the socket closes.
    const state = readyState();
    let phaseWhenClosing = null;
    const { shutdown } = build({
      state,
      resources: [
        {
          name: "probe",
          close: async () => {
            phaseWhenClosing = state.phase;
          },
        },
      ],
    });

    await shutdown.shutdown(0);
    assert.equal(phaseWhenClosing, Phase.DRAINING);
  });

  test("waits out the drain delay before closing the listener", async () => {
    const started = Date.now();
    const { shutdown } = build({ config: { drainDelayMs: 60 } });
    await shutdown.shutdown(0);
    assert.ok(Date.now() - started >= 55, "must give the load balancer time to notice");
  });

  test("continues closing after one resource fails", async () => {
    const closed = [];
    const { shutdown, exits } = build({
      resources: [
        {
          name: "broken",
          close: async () => {
            throw new Error("stuck");
          },
        },
        { name: "mongo", close: async () => closed.push("mongo") },
      ],
    });

    await shutdown.shutdown(0);
    // A stuck Redis must not leak a Mongo connection.
    assert.deepEqual(closed, ["mongo"]);
    assert.deepEqual(exits, [0]);
  });

  test("is idempotent, so a second signal joins the first shutdown", async () => {
    let closes = 0;
    const { shutdown, exits } = build({
      resources: [{ name: "r", close: async () => (closes += 1) }],
    });

    // SIGTERM then SIGINT is a normal sequence, not an error.
    await Promise.all([shutdown.shutdown(0), shutdown.shutdown(0), shutdown.shutdown(0)]);
    assert.equal(closes, 1);
    assert.equal(exits.length, 1);
  });

  test("forces an exit when a resource hangs past the grace period", async () => {
    const { shutdown, exits } = build({
      config: { graceMs: 50, drainDelayMs: 0 },
      resources: [{ name: "hangs", close: () => new Promise(() => {}) }],
    });

    shutdown.shutdown(0);
    await new Promise((r) => setTimeout(r, 120));
    // Without a deadline, a hung close turns a graceful shutdown into a
    // SIGKILL — exactly what the sequence exists to prevent.
    assert.deepEqual(exits, [1]);
  });

  test("propagates a non-zero exit code from a fatal error", async () => {
    const { shutdown, exits } = build();
    await shutdown.shutdown(1);
    assert.deepEqual(exits, [1]);
  });

  test("detaching removes every process listener it added", () => {
    const { shutdown } = build();
    const before = process.listenerCount("SIGTERM");
    const detach = shutdown.listen();
    assert.equal(process.listenerCount("SIGTERM"), before + 1);
    detach();
    assert.equal(process.listenerCount("SIGTERM"), before);
  });
});

describe("GracefulShutdown with a live server", () => {
  test("readiness reports 503 before the socket is closed", async () => {
    const app = await startTestServer();
    const { shutdown } = build({ state: app.state, config: { drainDelayMs: 150 } });
    shutdown.attach(app.server);

    const draining = shutdown.shutdown(0);

    // Mid-drain the server is still listening but must already be out of
    // rotation — that overlap is the whole point of the delay.
    await new Promise((r) => setTimeout(r, 40));
    const { response, body } = await app.json("/ready");
    assert.equal(response.status, 503);
    assert.equal(body.reason, "shutting down");
    assert.equal((await app.get("/live")).status, 200, "still alive while draining");

    await draining;
    assert.equal(app.server.listening, false);
  });

  test("an in-flight request completes after shutdown begins", async () => {
    const app = await startTestServer();
    const { shutdown } = build({ state: app.state, config: { drainDelayMs: 100 } });
    shutdown.attach(app.server);

    const inFlight = app.get("/version");
    shutdown.shutdown(0);

    const response = await inFlight;
    assert.equal(response.status, 200, "in-flight work must not be cut off");
    await app.close();
  });
});
