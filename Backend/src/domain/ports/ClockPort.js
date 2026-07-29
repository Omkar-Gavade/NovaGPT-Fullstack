/**
 * Time, as a dependency.
 *
 * The domain never calls `Date.now()` directly. That rule is what makes
 * time-dependent behaviour — breaker cooldowns, cache TTLs, token expiry —
 * testable by advancing a fake clock instead of by waiting or by patching
 * globals (docs/backend/02-architecture.md#domain-layer-srcdomain).
 *
 * @typedef {object} ClockPort
 * @property {() => number} now            milliseconds since the epoch
 * @property {() => Date}   date           current time as a Date
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 */

export {};
