import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";
import { ProcessObserver, sustain, burst } from "./loadHarness.js";

/**
 * The five documented load scenarios
 * ([12](../../../docs/backend/12-testing.md#load-testing)), scaled to run in
 * CI in seconds rather than in staging for ten minutes.
 *
 * **The scale-down is honest about what it costs.** Ten minutes at 100
 * concurrent streams finds a slow leak that thirty seconds at 25 will not. What
 * this suite does catch is a *fast* leak, an unbounded structure, a starved
 * short request, and a breaker that thrashes — all of which are real defects
 * that shipped in systems like this one, and all of which are cheap to check on
 * every commit. `LOAD_SCALE=20 npm run test:load` runs the documented profile
 * against a staging deployment.
 *
 * These tests are **not in the default suite**: they take tens of seconds and
 * they measure timing, which makes them the wrong shape for a pre-commit run.
 * `npm run test:load` runs them; the deploy pipeline runs them against staging.
 */

const SCALE = Number(process.env.LOAD_SCALE ?? 1);
const scaled = (base) => Math.max(1, Math.round(base * SCALE));

describe("load — sustained streaming", () => {
  let app;
  let token;

  before(async () => {
    // Telemetry retention off: the harness otherwise keeps every log line and
    // every span tree, and the heap assertion would be measuring the test.
    app = await startApp({
      providers: [buildMockProvider({ latencyMs: 5 })],
      retainTelemetry: false,
    });
    token = (await app.principal()).token;
  });
  after(() => app.close());

  test("memory is stable under sustained concurrent streams", async () => {
    // The headline scenario. A stream holds a buffer, a reader and a socket;
    // if any of the three outlives the request, this is where it shows.
    // Conversations and usage records live in Mongo in production, and in a
    // growing array here. Draining them keeps the heap measurement about the
    // *server* rather than about the substituted store — the same reason
    // telemetry retention is off for this app.
    const reaper = setInterval(() => {
      app.threads.clear();
      app.usage.clear();
    }, 400);
    reaper.unref?.();

    const stream = () =>
      app.sse("/api/v1/chat/stream", { message: "sustained load" }, { token });

    // **Warm up before measuring.** V8 grows its heap to fit the working set,
    // and connection pools, JIT tiers and the metric registry all fill on the
    // way in. Measuring across that ramp reports the process reaching steady
    // state as though it were a leak — which is what the first version of this
    // test did, consistently, on code with no leak in it.
    await sustain({ concurrency: scaled(25), durationMs: scaled(2000), worker: stream });

    const observer = new ProcessObserver().start();
    const stats = await sustain({
      concurrency: scaled(25),
      durationMs: scaled(4000),
      worker: stream,
    });
    const process_ = observer.stop();
    clearInterval(reaper);

    assert.equal(stats.failed, 0, `failures: ${JSON.stringify(stats.errors)}`);
    assert.ok(stats.completed > 0);

    // Retained memory, measured at the sawtooth's floor rather than its mean.
    // 1.3x is tight enough to catch a real leak precisely because the metric is
    // stable — a noisy metric forces a threshold so loose it catches nothing.
    assert.ok(
      process_.heapGrowthRatio < 1.3,
      `retained heap grew ${process_.heapGrowthRatio}x ` +
        `(floor ${process_.heapFloorStartMb}MB → ${process_.heapFloorEndMb}MB, peak ${process_.heapPeakMb}MB)`
    );

    // The Node-specific vital sign. Rising lag means every request is slowing,
    // including the health check — which is how an instance ends up marked
    // healthy while serving nothing.
    assert.ok(
      process_.eventLoopLagP99Ms < 250,
      `event-loop lag p99 ${process_.eventLoopLagP99Ms}ms`
    );
  });

  test("every stream is released, so the gauge returns to zero", async () => {
    // A registry entry that outlives its stream is the specific leak that also
    // makes an autoscaler believe an idle instance is saturated.
    await sustain({
      concurrency: scaled(10),
      durationMs: scaled(1500),
      worker: () => app.sse("/api/v1/chat/stream", { message: "release me" }, { token }),
    });

    assert.equal(app.streamRegistry.size, 0, "streams leaked into the registry");
  });
});

describe("load — burst", () => {
  test("sheds load rather than falling over", async () => {
    // 500 at once against a 20/minute limit. The point is not that most are
    // refused — that is the limit working — but that the refusals are *clean*
    // 429s with a Retry-After, and that the ones inside the limit still work.
    const app = await startApp({
      providers: [buildMockProvider({ latencyMs: 1 })],
      config: {
        rateLimit: {
          anonymousPerMinute: 100_000,
          authPerMinute: 100_000,
          chatPerMinute: 20,
          chatPerHour: 100_000,
        },
      },
    });

    try {
      const token = (await app.principal()).token;
      const codes = new Map();

      await burst({
        count: scaled(150),
        worker: async () => {
          const { status } = await app.post("/api/v1/chat", { message: "burst" }, { token });
          codes.set(status, (codes.get(status) ?? 0) + 1);
        },
      });

      assert.ok((codes.get(200) ?? 0) > 0, "nothing succeeded");
      assert.ok((codes.get(429) ?? 0) > 0, "nothing was shed");
      // No 500s. Shedding is a designed response; collapsing is not.
      assert.equal(codes.get(500) ?? 0, 0, `unexpected server errors: ${[...codes]}`);
    } finally {
      await app.close();
    }
  });
});

describe("load — mixed traffic", () => {
  test("a short request is not starved by long streams", async () => {
    // Node is single-threaded, so a stream that hogs the loop delays every
    // catalog read behind it. Users notice this as "the whole app is slow
    // whenever anyone is generating".
    const app = await startApp({ providers: [buildMockProvider({ latencyMs: 30 })] });

    try {
      const token = (await app.principal()).token;
      const observer = new ProcessObserver().start();

      const streams = sustain({
        concurrency: scaled(15),
        durationMs: scaled(3000),
        worker: () => app.sse("/api/v1/chat/stream", { message: "long one" }, { token }),
      });

      const catalog = await sustain({
        concurrency: 2,
        durationMs: scaled(3000),
        worker: async () => {
          const { status } = await app.json("/api/v1/models", { token });
          if (status !== 200) throw new Error(`catalog returned ${status}`);
        },
      });

      await streams;
      observer.stop();

      assert.equal(catalog.failed, 0);
      // The catalog is a cached in-memory read. Under streaming load it should
      // still answer in tens of milliseconds, not seconds.
      assert.ok(catalog.p95Ms < 500, `catalog p95 was ${catalog.p95Ms}ms under streaming load`);
    } finally {
      await app.close();
    }
  });
});

describe("load — provider degradation under load", () => {
  test("failover works at concurrency, and the breaker does not thrash", async () => {
    // Failover working at one request per second proves very little. The
    // failure mode this catches is a breaker that opens and closes repeatedly
    // under parallel traffic, which produces bursts of user-visible errors
    // between recoveries.
    const failing = buildMockProvider({ latencyMs: 2 });
    failing.script(Array.from({ length: 500 }, () => ({ fail: "timeout" })));

    const app = await startApp({ providers: [failing], retainTelemetry: true });
    try {
      const token = (await app.principal()).token;

      const stats = await sustain({
        concurrency: scaled(20),
        durationMs: scaled(2000),
        worker: async () => {
          // Every response is acceptable *except* a crash: the provider is
          // failing, so 503 is correct behaviour.
          // 503 (no candidate left) and 504 (the attempts ran out the budget)
          // are both correct answers when every provider is failing. Anything
          // else at 5xx is the system falling over rather than shedding.
          const { status } = await app.post("/api/v1/chat", { message: "degraded" }, { token });
          if (status >= 500 && status !== 503 && status !== 504) {
            throw new Error(`unexpected ${status}`);
          }
        },
      });

      assert.equal(stats.failed, 0, `unexpected failures: ${JSON.stringify(stats.errors)}`);

      // Once open, the breaker must stay open rather than flapping: each
      // reopening spends a real request on a provider already known to be down.
      const opened = app.logger.lines.filter((l) => l.event === "providers.breaker_opened").length;
      assert.ok(opened <= 3, `breaker opened ${opened} times — it is thrashing`);
    } finally {
      await app.close();
    }
  });
});
