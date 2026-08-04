import { SpanStatus } from "./Span.js";

/**
 * Which finished traces are worth keeping.
 *
 * **Tail-based, not head-based, and that is the whole point.** A head-based
 * sampler decides at the first span — before anything has happened — so it
 * throws away exactly the traces that turn out to matter: the one that failed,
 * the one that failed over twice, the one that took nine seconds. Deciding
 * *after* the request completes costs the memory to hold the spans until then,
 * and buys traces that are actually about problems
 * (docs/backend/11-observability.md#sampling).
 *
 * Pure: it takes a finished trace and returns a decision. No clock, no storage,
 * no I/O — so every rule below is a unit test rather than something observed
 * later in a sampling backend nobody can reproduce.
 */

export const SampleReason = {
  ERROR: "error",
  FAILOVER: "failover",
  SLOW: "slow",
  PROBABILISTIC: "probabilistic",
  DROPPED: "dropped",
};

export class SamplingPolicy {
  /**
   * @param {object} [options]
   * @param {number} [options.normalRate] fraction of ordinary successes kept
   * @param {number} [options.slowThresholdMs] treat a root span at or over this
   *        as slow. Approximates "above p95" without a live percentile.
   * @param {() => number} [options.random] injectable for deterministic tests
   */
  constructor({ normalRate = 0.05, slowThresholdMs = 5000, random = Math.random } = {}) {
    this.normalRate = normalRate;
    this.slowThresholdMs = slowThresholdMs;
    this.random = random;
  }

  /**
   * @param {import("./Span.js").Span[]} spans one complete trace
   * @returns {{keep: boolean, reason: string}}
   */
  decide(spans) {
    if (!spans?.length) return { keep: false, reason: SampleReason.DROPPED };

    // Errors are kept unconditionally. Sampling away a failed trace defeats the
    // reason traces exist.
    if (spans.some((span) => span.status === SpanStatus.ERROR || isServerError(span))) {
      return { keep: true, reason: SampleReason.ERROR };
    }

    // A failover means the request survived a provider problem. It succeeded,
    // so no error marks it — and it is one of the most informative traces the
    // system can produce.
    if (spans.some((span) => span.attributes?.["routing.switched"] === true)) {
      return { keep: true, reason: SampleReason.FAILOVER };
    }

    // The tail is where problems live. A fixed threshold rather than a live
    // p95: a percentile computed from the traces you kept is circular, and the
    // threshold is a configured number an operator can reason about.
    const root = spans.find((span) => span.isRoot) ?? spans[0];
    if ((root.durationMs ?? 0) >= this.slowThresholdMs) {
      return { keep: true, reason: SampleReason.SLOW };
    }

    // Everything else: enough for a latency distribution, and nothing like a
    // full trace of every fast request.
    if (this.random() < this.normalRate) {
      return { keep: true, reason: SampleReason.PROBABILISTIC };
    }

    return { keep: false, reason: SampleReason.DROPPED };
  }
}

/**
 * A 5xx response is an error even when nothing threw.
 *
 * The HTTP layer records the status as an attribute rather than failing the
 * root span, because ending a span early to mark it would freeze its duration
 * before the response finished. 4xx is deliberately *not* an error here: it is
 * the caller's mistake, and keeping every validation failure at 100% would
 * bury the traces that are actually about the system.
 */
function isServerError(span) {
  const status = span.attributes?.["http.status_code"];
  return typeof status === "number" && status >= 500;
}
