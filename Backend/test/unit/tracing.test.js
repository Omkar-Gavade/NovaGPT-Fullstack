import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Span, SpanStatus } from "../../src/domain/observability/Span.js";
import { SamplingPolicy, SampleReason } from "../../src/domain/observability/SamplingPolicy.js";
import { Tracer, nullTracer } from "../../src/infrastructure/telemetry/Tracer.js";
import { recordingMetrics } from "../helpers/testDoubles.js";

const span = ({ name = "s", parent = null, duration = 10, status = SpanStatus.OK, attributes = {} } = {}) => {
  const built = new Span({
    name,
    spanId: name,
    traceId: "t",
    parentSpanId: parent,
    startedAt: 0,
    attributes,
  });
  built.end(duration, { status });
  return built;
};

describe("SamplingPolicy", () => {
  const never = new SamplingPolicy({ normalRate: 0, slowThresholdMs: 5000, random: () => 0.99 });

  test("keeps every failed trace, whatever the sample rate", () => {
    // Sampling away a failed trace defeats the reason traces exist.
    const decision = never.decide([span({ status: SpanStatus.ERROR })]);
    assert.deepEqual(decision, { keep: true, reason: SampleReason.ERROR });
  });

  test("treats a 5xx as an error even though nothing threw", () => {
    const root = span({ attributes: { "http.status_code": 503 } });
    assert.equal(never.decide([root]).keep, true);
  });

  test("does not treat a 4xx as an error", () => {
    // Keeping every validation failure at 100% would bury the traces that are
    // actually about the system.
    const root = span({ attributes: { "http.status_code": 400 } });
    assert.equal(never.decide([root]).keep, false);
  });

  test("keeps a failover even when it succeeded", () => {
    // It carries no error, so nothing else distinguishes it from an ordinary
    // request — and it is one of the most informative traces available.
    const root = span();
    const child = span({ name: "c", parent: "s", attributes: { "routing.switched": true } });
    assert.equal(never.decide([root, child]).reason, SampleReason.FAILOVER);
  });

  test("keeps a slow trace", () => {
    assert.equal(never.decide([span({ duration: 9000 })]).reason, SampleReason.SLOW);
  });

  test("samples ordinary successes at the configured rate", () => {
    const always = new SamplingPolicy({ normalRate: 0.05, random: () => 0.01 });
    const rarely = new SamplingPolicy({ normalRate: 0.05, random: () => 0.9 });

    assert.equal(always.decide([span()]).reason, SampleReason.PROBABILISTIC);
    assert.equal(rarely.decide([span()]).keep, false);
  });

  test("an empty trace is dropped rather than exported as nothing", () => {
    assert.equal(never.decide([]).keep, false);
    assert.equal(never.decide(undefined).keep, false);
  });
});

describe("Tracer", () => {
  const build = ({ policy } = {}) => {
    let now = 0;
    const exported = [];
    const metrics = recordingMetrics();
    const tracer = new Tracer({
      clock: { now: () => (now += 5) },
      exporter: { export: (trace) => exported.push(trace) },
      policy: policy ?? new SamplingPolicy({ normalRate: 1 }),
      metrics,
    });
    return { tracer, exported, metrics };
  };

  test("nests spans by where they were opened, not by an argument", async () => {
    // Threading a parent explicitly would put an observability concern into the
    // signature of every function it passes through.
    const { tracer, exported } = build();

    await tracer.span("http.request", async () => {
      await tracer.span("routing.decide", async () => {});
      await tracer.span("provider.invoke", async () => {
        await tracer.span("http.client", async () => {});
      });
    });

    const [trace] = exported;
    const byName = Object.fromEntries(trace.spans.map((s) => [s.name, s]));

    assert.equal(byName["http.request"].parentSpanId, null);
    assert.equal(byName["routing.decide"].parentSpanId, byName["http.request"].spanId);
    assert.equal(byName["http.client"].parentSpanId, byName["provider.invoke"].spanId);
    assert.equal(new Set(trace.spans.map((s) => s.traceId)).size, 1);
  });

  test("a throwing operation is still timed and recorded", async () => {
    // An operation that only produces a span when it succeeds is missing
    // exactly the spans worth having.
    const { tracer, exported } = build();

    await assert.rejects(() =>
      tracer.span("http.request", async () => {
        await tracer.span("provider.invoke", async () => {
          throw Object.assign(new Error("upstream exploded"), { failureKind: "outage" });
        });
      })
    );

    const failed = exported[0].spans.find((s) => s.name === "provider.invoke");
    assert.equal(failed.status, SpanStatus.ERROR);
    assert.equal(failed.attributes["error.kind"], "outage");
    assert.ok(failed.durationMs > 0);
  });

  test("the error attributes carry no cause chain", async () => {
    // `cause` is where upstream response bodies and connection strings live.
    const { tracer, exported } = build();
    const error = new Error("failed");
    error.cause = { apiKey: "sk-live-should-never-appear" };

    await assert.rejects(() => tracer.span("http.request", async () => { throw error; }));

    assert.ok(!JSON.stringify(exported[0]).includes("sk-live"));
  });

  test("exports only when the root ends, never per span", async () => {
    // Tail-based sampling needs the whole trace before it can decide.
    const { tracer, exported } = build();

    await tracer.span("http.request", async () => {
      await tracer.span("child", async () => {});
      assert.equal(exported.length, 0, "nothing may be exported mid-trace");
    });

    assert.equal(exported.length, 1);
  });

  test("counts both kept and dropped traces", async () => {
    const { tracer, metrics } = build({ policy: new SamplingPolicy({ normalRate: 0, random: () => 1 }) });
    await tracer.span("http.request", async () => {});

    const counted = metrics.calls.increment.find((c) => c.name === "nova_traces_sampled_total");
    assert.equal(counted.labels.decision, "dropped");
  });

  test("bounds a trace and says how much it dropped", async () => {
    // A retry storm must not be able to grow a trace without limit, and a
    // truncated trace must not pretend to be whole.
    let now = 0;
    const exported = [];
    const tracer = new Tracer({
      clock: { now: () => (now += 1) },
      exporter: { export: (t) => exported.push(t) },
      policy: new SamplingPolicy({ normalRate: 1 }),
      maxSpansPerTrace: 3,
    });

    await tracer.span("http.request", async () => {
      for (let i = 0; i < 10; i += 1) await tracer.span(`child-${i}`, async () => {});
    });

    assert.equal(exported[0].spans.length, 3);
    assert.equal(exported[0].droppedSpans, 8);
  });

  test("an exporter defect never reaches the request", async () => {
    const tracer = new Tracer({
      clock: { now: () => 1 },
      exporter: {
        export: () => {
          throw new Error("exporter down");
        },
      },
      policy: new SamplingPolicy({ normalRate: 1 }),
    });

    await assert.doesNotReject(() => tracer.span("http.request", async () => "value"));
  });

  test("propagates W3C traceparent outward", async () => {
    // So a provider or gateway that traces joins ours instead of starting an
    // unrelated trace.
    const { tracer } = build();
    let header;
    await tracer.span("http.request", async () => {
      header = tracer.outboundHeaders().traceparent;
    });

    assert.match(header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.deepEqual(tracer.outboundHeaders(), {}, "no header outside a trace");
  });

  test("times a generator over its whole run, not its creation", async () => {
    // Wrapping an async generator in `span()` would time the few microseconds
    // it takes to *create* it rather than the seconds it streams for.
    let now = 0;
    const exported = [];
    const tracer = new Tracer({
      clock: { now: () => now },
      exporter: { export: (t) => exported.push(t) },
      policy: new SamplingPolicy({ normalRate: 1 }),
    });

    async function* body() {
      now = 100;
      yield 1;
      now = 4000;
      yield 2;
    }

    const out = [];
    for await (const value of tracer.spanGenerator("stream", body)) out.push(value);

    assert.deepEqual(out, [1, 2]);
    assert.equal(exported[0].spans[0].durationMs, 4000);
  });
});

describe("nullTracer", () => {
  test("still runs the work it wraps", async () => {
    // A no-op tracer that skipped the callback would silently disable whatever
    // it was measuring.
    assert.equal(await nullTracer.span("x", async () => "ran"), "ran");
    assert.equal(nullTracer.active(), null);
    assert.deepEqual(nullTracer.outboundHeaders(), {});
  });
});
