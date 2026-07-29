/**
 * Ephemeral shared state, as a dependency.
 *
 * Two implementations exist and both are first-class: Redis for a multi-instance
 * deployment, and an in-process map for a single instance or for when Redis is
 * unreachable. Redis being down MUST degrade, never break
 * (docs/backend/08-storage.md#redis-must-be-optional-and-what-that-costs) —
 * which is only testable because the degraded path is a real implementation of
 * this same interface rather than a special case inside the caller.
 *
 * @typedef {object} CachePort
 * @property {(key: string) => Promise<unknown|null>} get
 * @property {(key: string, value: unknown, ttlMs?: number) => Promise<void>} set
 * @property {(key: string) => Promise<void>} del
 * @property {(key: string, ttlMs: number) => Promise<number>} increment  returns the new count
 * @property {() => Promise<boolean>} isHealthy
 * @property {() => Promise<void>} close
 * @property {string} kind  "redis" | "memory" — surfaced so degradation is visible
 */

export {};
