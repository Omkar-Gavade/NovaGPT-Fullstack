/**
 * A dependency that can report whether it is usable right now.
 *
 * Implemented by the Mongo connection and the cache so readiness can aggregate
 * them without knowing what either one is
 * (docs/backend/09-api-design.md#operations).
 *
 * `critical` distinguishes a dependency whose loss means this instance should
 * stop receiving traffic from one whose loss only degrades it. Redis is not
 * critical; Mongo is.
 *
 * @typedef {object} ProbeResult
 * @property {string} name
 * @property {boolean} ok
 * @property {boolean} critical
 * @property {number} latencyMs
 * @property {string} [detail]   client-safe; never a connection string
 *
 * @typedef {object} HealthProbePort
 * @property {string} name
 * @property {boolean} critical
 * @property {() => Promise<ProbeResult>} probe
 */

export {};
