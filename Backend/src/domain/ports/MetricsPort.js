/**
 * Metrics, as a dependency.
 *
 * Label values MUST be low-cardinality identifiers. Never a user id, thread id,
 * or trace id: each distinct label combination is a separate time series, and
 * that is how a metrics bill outgrows a compute bill
 * (docs/backend/11-observability.md#cardinality-discipline). The implementation
 * enforces an allowlist rather than trusting the caller.
 *
 * @typedef {object} MetricsPort
 * @property {(name: string, labels?: object, value?: number) => void} increment
 * @property {(name: string, value: number, labels?: object) => void} observe
 * @property {(name: string, value: number, labels?: object) => void} setGauge
 * @property {() => Promise<string>} render  Prometheus exposition format
 * @property {() => string} contentType
 */

export {};
