/**
 * Usage records, as a dependency.
 *
 * Append-mostly: `record` and aggregate reads, no update. A usage record is a
 * statement about something that already happened, and editing one is either a
 * bug or a fraud — the correction for a wrong price is a new price entry with
 * an effective date, not a rewrite of history
 * (docs/backend/11-observability.md#cost-monitoring).
 *
 * @typedef {object} UsageRepositoryPort
 * @property {(record: object) => Promise<void>} record
 * @property {(query: object) => Promise<object[]>} list
 * @property {(query: object) => Promise<{tokens: number, costUsd: number, wastedTokens: number, attempts: number}>} summarise
 * @property {(cutoff: Date) => Promise<number>} purgeBefore
 */

export {};
