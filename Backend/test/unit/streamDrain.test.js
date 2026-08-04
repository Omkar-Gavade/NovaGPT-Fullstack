import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StreamRegistry } from "../../src/application/chat/StreamRegistry.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { recordingMetrics } from "../helpers/testDoubles.js";

/**
 * Draining in-flight streams at shutdown.
 *
 * A deploy that kills every live generation visibly breaks the conversation of
 * whoever happened to be mid-answer — and rolling deploys happen far more often
 * than incidents do, so this is the failure users would actually meet
 * (docs/backend/13-deployment.md#graceful-shutdown).
 *
 * The budget is the other half. Some generations run for minutes, and a drain
 * that waits for all of them is a deploy that never finishes.
 */

const build = () =>
  new StreamRegistry({ clock: new SystemClock(), metrics: recordingMetrics() });

describe("StreamRegistry.drain", () => {
  test("returns immediately when nothing is in flight", async () => {
    const registry = build();
    const result = await registry.drain(5000);

    assert.deepEqual({ drained: result.drained, aborted: result.aborted }, { drained: 0, aborted: 0 });
    assert.ok(result.waitedMs < 100, "an idle instance must not sit out the budget");
  });

  test("waits for a stream that finishes on its own", async () => {
    const registry = build();
    const controller = registry.register("finishing", { threadId: "t1" });

    // The stream completes shortly after the drain begins — the common case,
    // and the one that must not be cut.
    setTimeout(() => registry.release("finishing"), 60);

    const result = await registry.drain(3000);
    assert.equal(result.drained, 1);
    assert.equal(result.aborted, 0);
    assert.equal(controller.signal.aborted, false, "a stream that finished must not be aborted");
  });

  test("aborts what is still running when the budget runs out", async () => {
    // Otherwise one very long generation holds a rolling deploy open
    // indefinitely, and the orchestrator SIGKILLs the process — which cuts
    // *every* stream instead of the one straggler.
    const registry = build();
    const controller = registry.register("endless", { threadId: "t1" });

    const result = await registry.drain(120, 20);

    assert.equal(result.aborted, 1);
    assert.equal(controller.signal.aborted, true);
    assert.equal(registry.size, 0);
  });

  test("drains the finishers and aborts only the straggler", async () => {
    const registry = build();
    const quick = registry.register("quick", { threadId: "t1" });
    const slow = registry.register("slow", { threadId: "t2" });

    setTimeout(() => registry.release("quick"), 40);

    const result = await registry.drain(150, 20);

    assert.equal(result.drained, 1);
    assert.equal(result.aborted, 1);
    assert.equal(quick.signal.aborted, false);
    assert.equal(slow.signal.aborted, true);
  });

  test("the gauge returns to zero, whichever way a stream ended", async () => {
    // A gauge that only decrements on the happy path climbs forever, and an
    // autoscaler believes it.
    const metrics = recordingMetrics();
    const registry = new StreamRegistry({ clock: new SystemClock(), metrics });

    registry.register("a", { threadId: "t" });
    registry.register("b", { threadId: "t" });
    await registry.drain(50, 10);

    const last = metrics.calls.setGauge.filter((c) => c.name === "nova_active_streams").at(-1);
    assert.equal(last.value, 0);
  });
});
