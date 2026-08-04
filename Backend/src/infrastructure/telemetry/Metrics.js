import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Metrics implementing MetricsPort, backed by prom-client.
 *
 * The metric set is declared up front rather than created on demand. Two
 * reasons, both learned the expensive way in systems like this:
 *
 *   1. A metric that only exists after it first fires is invisible on a
 *      dashboard until something goes wrong — exactly when you need the
 *      baseline it never recorded. Declared metrics export a zero.
 *   2. Labels are the cost driver. Each distinct combination is a time series,
 *      so an unbounded label (a user id, a raw URL) is how a metrics bill
 *      outgrows a compute bill
 *      (docs/backend/11-observability.md#cardinality-discipline).
 *
 * The allowlist is enforced here, in the wrapper, rather than left to
 * convention — a rule that depends on remembering is not a rule.
 */

/** name -> definition. The complete set of metrics this phase emits. */
const DEFINITIONS = [
  {
    name: "nova_requests_total",
    type: "counter",
    help: "HTTP requests handled, by route, method and status class.",
    labels: ["route", "method", "status"],
  },
  {
    name: "nova_request_duration_seconds",
    type: "histogram",
    help: "HTTP request duration in seconds.",
    labels: ["route", "method"],
    // Bucketed for an API whose fast paths are single-digit milliseconds and
    // whose slow paths are model calls measured in seconds.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  },
  {
    name: "nova_request_errors_total",
    type: "counter",
    help: "Requests that ended in an error, by error kind.",
    labels: ["route", "kind"],
  },
  {
    name: "nova_dependency_up",
    type: "gauge",
    help: "Whether a dependency is currently reachable (1) or not (0).",
    labels: ["dependency"],
  },
  {
    name: "nova_dependency_probe_duration_seconds",
    type: "histogram",
    help: "Health-probe duration per dependency.",
    labels: ["dependency"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  },
  {
    name: "nova_shutdown_in_progress",
    type: "gauge",
    help: "1 while the process is draining for shutdown.",
    labels: [],
  },

  /* ---- routing (docs/backend/11-observability.md#routing-metrics) ---- */
  {
    name: "nova_routing_decisions_total",
    type: "counter",
    help: "Routing decisions, by chosen model and selection mode.",
    labels: ["model", "provider", "mode"],
  },
  {
    name: "nova_routing_failovers_total",
    type: "counter",
    help: "Failovers, by origin provider, destination provider and cause.",
    labels: ["from", "to", "reason"],
  },
  {
    name: "nova_routing_retries_total",
    type: "counter",
    help: "Same-provider retries, by provider and failure kind.",
    labels: ["provider", "kind"],
  },
  {
    name: "nova_routing_exhausted_total",
    type: "counter",
    help: "Requests that ran out of candidates, by reason.",
    labels: ["reason"],
  },
  {
    name: "nova_routing_candidates",
    type: "histogram",
    help: "Eligible models per routing decision.",
    labels: [],
    // A falling candidate count is a leading indicator: the fleet degrades
    // provider by provider, and it is visible here *before* requests fail.
    buckets: [0, 1, 2, 3, 5, 8, 13, 21],
  },
  {
    name: "nova_routing_decision_duration_seconds",
    type: "histogram",
    help: "Time spent deciding a route (pure policy, no I/O).",
    labels: [],
    // Runs on every request and competes with active streams for the event
    // loop, so the target is single-digit milliseconds.
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  },
  /* ---- streaming (docs/backend/11-observability.md#request-metrics) ---- */
  {
    name: "nova_active_streams",
    type: "gauge",
    help: "Streams currently in flight on this instance.",
    labels: [],
  },
  {
    name: "nova_stream_duration_seconds",
    type: "histogram",
    help: "Wall time of a streaming generation, first byte to terminal event.",
    labels: ["provider", "model", "outcome"],
    buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  },
  {
    name: "nova_stream_ttft_seconds",
    type: "histogram",
    help: "Time to first token.",
    labels: ["provider", "model"],
    // **The metric that matters most for perceived speed.** A 30-second
    // generation that starts in 300 ms feels fast; a 3-second generation that
    // starts after 2.5 s feels broken. Total duration averages the two into a
    // number describing neither, so the buckets here are tight at the low end
    // where the difference is actually felt.
    buckets: [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20],
  },

  /* ---- context (docs/backend/11-observability.md#context-metrics) ---- */
  {
    name: "nova_context_tokens",
    type: "histogram",
    help: "Estimated prompt tokens per assembled context.",
    labels: [],
    buckets: [100, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 200_000],
  },
  {
    name: "nova_context_trimmed_total",
    type: "counter",
    help: "Contexts that required trimming to fit the budget.",
    labels: [],
  },
  {
    name: "nova_context_compressions_total",
    type: "counter",
    help: "Contexts in which a span was compressed to a summary.",
    labels: [],
  },
  {
    name: "nova_token_estimate_error_ratio",
    type: "histogram",
    help: "Estimated prompt tokens divided by the provider's reported count.",
    labels: [],
    // Centred on 1.0, because that is the only interesting value. Consistent
    // underestimation causes provider rejections; consistent overestimation
    // wastes context. Without this the estimator's accuracy is an assumption
    // nobody ever checks (docs/backend/06-context-engine.md#token-estimation).
    buckets: [0.5, 0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3, 1.5, 2.0],
  },

  /* ---- provider health and spend ---- */
  {
    name: "nova_provider_health",
    type: "gauge",
    help: "Rolling success ratio per provider, 0 to 1.",
    labels: ["provider"],
  },
  {
    name: "nova_provider_breaker_state",
    type: "gauge",
    help: "Circuit state: 0 closed, 0.5 half-open, 1 open.",
    labels: ["provider"],
  },
  {
    name: "nova_provider_tokens_total",
    type: "counter",
    help: "Tokens consumed, by direction.",
    // Free-tier tokens are counted too. Free tiers have limits — token
    // consumption is the resource whether or not it is billed
    // (docs/backend/11-observability.md#cost-monitoring).
    labels: ["provider", "model", "direction"],
  },
  {
    name: "nova_provider_cost_usd_total",
    type: "counter",
    help: "Measured spend in USD, from reported token counts and the price table.",
    labels: ["provider", "model"],
  },
  {
    name: "nova_wasted_tokens_total",
    type: "counter",
    help: "Tokens consumed by attempts that failed or were cancelled.",
    // The panel that justifies routing work: "15% of tokens are burned on
    // attempts nobody read" turns an engineering opinion into a decision.
    labels: ["provider", "reason"],
  },

  /* ---- tracing ---- */
  {
    name: "nova_traces_sampled_total",
    type: "counter",
    help: "Completed traces, by tail-sampling decision.",
    labels: ["decision", "reason"],
  },

  /* ---- attachments (docs/backend/09-api-design.md) ---- */
  {
    name: "nova_attachments_total",
    type: "counter",
    help: "Attachments accepted, by kind and how they arrived.",
    // `source` separates inline uploads from fetched URLs, which have very
    // different risk profiles — a rise in `url` is the SSRF surface being used.
    labels: ["kind", "source"],
  },
  {
    name: "nova_attachments_rejected_total",
    type: "counter",
    help: "Attachments refused, by reason.",
    labels: ["reason"],
  },

  /* ---- security (docs/backend/10-security.md) ---- */
  {
    name: "nova_auth_events_total",
    type: "counter",
    help: "Authentication events, by kind and outcome.",
    // No user id and no email: either would be an unbounded label, and the
    // second would put personal data in a metrics store that is not built for
    // it (docs/backend/11-observability.md#cardinality-discipline).
    labels: ["event", "outcome"],
  },
  {
    name: "nova_rate_limited_total",
    type: "counter",
    help: "Requests refused by a rate limit, by rule.",
    // `degraded` separates "this user is over the limit" from "the counter was
    // unreachable and the rule failed closed" — two very different alerts.
    labels: ["rule", "degraded"],
  },
  {
    name: "nova_authz_denied_total",
    type: "counter",
    help: "Requests refused by an authorization check, by route and reason.",
    labels: ["route", "reason"],
  },

  {
    name: "nova_provider_attempts_total",
    type: "counter",
    help: "Provider attempts, by provider, model and outcome.",
    labels: ["provider", "model", "outcome"],
  },
  {
    name: "nova_provider_attempt_duration_seconds",
    type: "histogram",
    help: "Duration of a single provider attempt.",
    labels: ["provider", "outcome"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  },
];

export class Metrics {
  /**
   * @param {object} [options]
   * @param {Record<string,string>} [options.defaultLabels]
   * @param {boolean} [options.collectDefaults] process CPU, heap, event-loop lag
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} [options.logger]
   */
  constructor({ defaultLabels = {}, collectDefaults = true, logger } = {}) {
    this.registry = new Registry();
    this.logger = logger;
    if (Object.keys(defaultLabels).length) this.registry.setDefaultLabels(defaultLabels);

    // Event-loop lag lives in here. It is the Node-specific vital sign: rising
    // lag means every request is slowing, including the health check.
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });

    /** @type {Map<string, {metric: object, labels: string[]}>} */
    this.metrics = new Map();
    for (const def of DEFINITIONS) this.#declare(def);
  }

  #declare(def) {
    const config = {
      name: def.name,
      help: def.help,
      labelNames: def.labels,
      registers: [this.registry],
    };
    const metric =
      def.type === "counter"
        ? new Counter(config)
        : def.type === "histogram"
        ? new Histogram({ ...config, buckets: def.buckets })
        : new Gauge(config);
    this.metrics.set(def.name, { metric, labels: def.labels });
  }

  /**
   * Drop any label not declared for this metric.
   *
   * Dropping rather than throwing is deliberate: an unexpected label is a
   * telemetry defect, and telemetry defects must not break the request they
   * were measuring. It is logged so it gets fixed.
   */
  #labelsFor(name, allowed, provided) {
    const out = {};
    for (const key of allowed) out[key] = normalise(provided?.[key]);
    if (provided) {
      for (const key of Object.keys(provided)) {
        if (!allowed.includes(key)) {
          this.logger?.warn("metrics.label_rejected", { metric: name, label: key });
        }
      }
    }
    return out;
  }

  #lookup(name) {
    const entry = this.metrics.get(name);
    if (!entry) this.logger?.warn("metrics.unknown_metric", { metric: name });
    return entry;
  }

  increment(name, labels, value = 1) {
    const entry = this.#lookup(name);
    entry?.metric.inc(this.#labelsFor(name, entry.labels, labels), value);
  }

  observe(name, value, labels) {
    const entry = this.#lookup(name);
    entry?.metric.observe(this.#labelsFor(name, entry.labels, labels), value);
  }

  setGauge(name, value, labels) {
    const entry = this.#lookup(name);
    entry?.metric.set(this.#labelsFor(name, entry.labels, labels), value);
  }

  render() {
    return this.registry.metrics();
  }

  contentType() {
    return this.registry.contentType;
  }

  /** Test isolation: prom-client metrics are stateful across a process. */
  reset() {
    this.registry.resetMetrics();
  }
}

/** Labels must be strings; `undefined` would silently create a distinct series. */
function normalise(value) {
  if (value === undefined || value === null) return "unknown";
  return String(value);
}

/**
 * No-op implementation for when metrics are disabled.
 *
 * A real object rather than a config check at every call site: callers should
 * not know whether metrics are on, and `metrics?.increment()` scattered through
 * the codebase is how a call site eventually forgets the `?`.
 */
export const nullMetrics = {
  increment() {},
  observe() {},
  setGauge() {},
  async render() {
    return "";
  },
  contentType() {
    return "text/plain";
  },
  reset() {},
};
