import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Span, SpanStatus } from "../../domain/observability/Span.js";
import { SamplingPolicy } from "../../domain/observability/SamplingPolicy.js";

/**
 * Span collection, nesting, and tail-based sampling.
 *
 * **Written here rather than pulled in from an OpenTelemetry SDK**, for the
 * reasons in ADR-024: tail-based sampling is the part with actual value, and
 * the SDK does not do it in-process — it needs a collector deployment to make
 * the decision downstream. What is left of the SDK for this system is span
 * plumbing, which is this file.
 *
 * Parents are found through async local storage, so nesting works across
 * `await` without any function taking a `parentSpan` argument. Threading one
 * explicitly would put an observability concern into the signature of every
 * domain function it passes through
 * (docs/backend/11-observability.md#correlation).
 *
 * The trace is buffered until the root span ends, because that is what
 * tail-based sampling requires: you cannot decide whether a trace is
 * interesting until you know how it turned out. The buffer is bounded, since an
 * unbounded one is a memory leak with a pathological request as its trigger.
 */
export class Tracer {
  /**
   * @param {object} deps
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {object} [deps.exporter] receives `{traceId, spans, reason}` for kept traces
   * @param {SamplingPolicy} [deps.policy]
   * @param {object} [deps.metrics]
   * @param {number} [deps.maxSpansPerTrace]
   */
  constructor({ clock, exporter, policy, metrics, maxSpansPerTrace = 200 } = {}) {
    this.clock = clock;
    this.exporter = exporter;
    this.policy = policy ?? new SamplingPolicy();
    this.metrics = metrics;
    this.maxSpansPerTrace = maxSpansPerTrace;
    this.storage = new AsyncLocalStorage();
  }

  /** The span currently in scope, or null outside any. */
  active() {
    return this.storage.getStore()?.span ?? null;
  }

  /**
   * Run `fn` inside a new span.
   *
   * `finally` ends the span, so a throw is still timed and still recorded — an
   * operation that only produces a span when it succeeds is missing exactly the
   * spans worth having.
   */
  async span(name, fn, attributes = {}) {
    const scope = this.#begin(name, attributes);
    try {
      const result = await this.storage.run(scope, () => fn(scope.span));
      this.#end(scope, SpanStatus.OK);
      return result;
    } catch (error) {
      this.#end(scope, SpanStatus.ERROR, error);
      throw error;
    }
  }

  /**
   * The generator form.
   *
   * A streaming response is an async generator, and wrapping one in `span()`
   * would time only how long it took to *create* the generator — a few
   * microseconds — rather than the several seconds it runs for.
   */
  async *spanGenerator(name, generatorFn, attributes = {}) {
    const scope = this.#begin(name, attributes);
    try {
      // The generator body runs inside the scope, so spans it opens nest.
      const iterator = this.storage.run(scope, () => generatorFn(scope.span));
      for await (const value of iterator) yield value;
      this.#end(scope, SpanStatus.OK);
    } catch (error) {
      this.#end(scope, SpanStatus.ERROR, error);
      throw error;
    }
  }

  /**
   * `traceparent` for an outbound call, or null when no trace is active.
   *
   * W3C format, so a provider or gateway that traces joins ours rather than
   * starting an unrelated one.
   */
  outboundHeaders() {
    const scope = this.storage.getStore();
    if (!scope) return {};
    return {
      traceparent: `00-${pad(scope.trace.traceId, 32)}-${pad(scope.span.spanId, 16)}-01`,
    };
  }

  #begin(name, attributes) {
    const parent = this.storage.getStore();
    const trace = parent?.trace ?? {
      traceId: hex(16),
      spans: [],
      dropped: 0,
    };

    const span = new Span({
      name,
      spanId: hex(8),
      traceId: trace.traceId,
      parentSpanId: parent?.span.spanId ?? null,
      startedAt: this.clock.now(),
      attributes,
    });

    // Bounded. A pathological request — a retry storm, a runaway loop — must
    // not be able to grow this without limit. Dropped spans are counted so the
    // trace says it is incomplete rather than pretending to be whole.
    if (trace.spans.length < this.maxSpansPerTrace) trace.spans.push(span);
    else trace.dropped += 1;

    return { trace, span };
  }

  #end(scope, status, error = null) {
    scope.span.end(this.clock.now(), { status, error });
    if (!scope.span.isRoot) return;

    // The root ended, so the trace is complete and the decision can finally be
    // made with knowledge of how it turned out.
    const { keep, reason } = this.policy.decide(scope.trace.spans);
    this.metrics?.increment("nova_traces_sampled_total", {
      decision: keep ? "kept" : "dropped",
      reason,
    });

    if (!keep) return;
    try {
      this.exporter?.export({
        traceId: scope.trace.traceId,
        reason,
        droppedSpans: scope.trace.dropped,
        spans: scope.trace.spans,
      });
    } catch {
      // An exporter defect must never surface as a request failure. It has
      // already been counted above, which is what makes the gap visible.
    }
  }
}

/**
 * Traces are exported as structured log events.
 *
 * The log pipeline already exists, already redacts, and already retains — and a
 * trace that lands beside the log lines from the same request is more useful
 * during an incident than one in a separate tool. When a tracing backend is
 * introduced, it implements this same one-method interface
 * (docs/backend/15-decisions.md#adr-024).
 */
export class LogSpanExporter {
  constructor({ logger }) {
    this.logger = logger?.child?.({ component: "tracing" }) ?? logger;
  }

  export({ traceId, reason, spans, droppedSpans }) {
    this.logger?.info("trace.sampled", {
      traceId,
      reason,
      spanCount: spans.length,
      droppedSpans: droppedSpans || undefined,
      durationMs: spans.find((s) => s.isRoot)?.durationMs ?? null,
      spans: spans.map((span) => span.toJSON()),
    });
  }
}

/**
 * A tracer that records nothing, for when tracing is off.
 *
 * A real object rather than a config check at every call site: callers must not
 * know whether tracing is enabled, and `tracer?.span(...)` scattered through
 * the codebase is how one call site eventually forgets the `?` — and how
 * another quietly stops running the work inside the callback.
 */
export const nullTracer = {
  active: () => null,
  span: (name, fn) => fn(null),
  spanGenerator: (name, generatorFn) => generatorFn(null),
  outboundHeaders: () => ({}),
};

const hex = (bytes) => randomBytes(bytes).toString("hex");
const pad = (value, length) => value.padStart(length, "0").slice(-length);
