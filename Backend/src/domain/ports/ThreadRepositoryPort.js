/**
 * Conversation persistence, as a dependency.
 *
 * Declared by the domain so the application layer never learns that Mongo
 * exists. Two implementations ship: a Mongo one for production and an
 * in-memory one used by tests and by a zero-dependency local run — the same
 * pattern as `CachePort`, and for the same reason: a degraded path that is a
 * real implementation of the interface is testable, while one expressed as
 * conditionals inside callers is not
 * (docs/backend/02-architecture.md#why-ports-are-owned-by-the-domain).
 *
 * Every method is **scoped by owner**. Scoping at the query rather than
 * checking after loading is what makes a forgotten check return nothing
 * instead of returning someone else's conversation
 * (docs/backend/10-security.md#authorization).
 *
 * @typedef {object} ThreadRepositoryPort
 * @property {(id: string, ownerId: string|null) => Promise<import("../conversation/Thread.js").Thread|null>} findById
 * @property {(id: string) => Promise<boolean>} existsById  unscoped, and used for exactly one
 *           thing: refusing to create a thread over an id that already belongs to someone else
 * @property {(shareId: string) => Promise<import("../conversation/Thread.js").Thread|null>} findByShareId
 * @property {(query: object) => Promise<{items: object[], nextCursor: string|null}>} list
 * @property {(thread: object) => Promise<object>} save
 * @property {(id: string, ownerId: string|null) => Promise<boolean>} softDelete
 * @property {() => Promise<boolean>} isHealthy
 */

export {};
