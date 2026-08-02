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
