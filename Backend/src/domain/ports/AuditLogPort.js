/**
 * The audit trail, as a dependency.
 *
 * Write-only from the application's point of view: there is an `append` and a
 * `query`, and deliberately no update and no delete. The real enforcement is at
 * the database role — an attacker with code execution defeats a rule expressed
 * in code, because it is the same compromise that made the log worth tampering
 * with (docs/backend/10-security.md#audit-logging).
 *
 * Entries record *who did what to which resource*, never content. Including
 * prompts would turn a one-year-retention audit log into the highest-value
 * disclosure target in the system (T13).
 *
 * @typedef {object} AuditEntry
 * @property {string} action        e.g. "auth.login", "thread.deleted"
 * @property {string|null} actorId
 * @property {string|null} actorIp
 * @property {string|null} resourceType
 * @property {string|null} resourceId
 * @property {"success"|"failure"|"denied"} outcome
 * @property {string|null} traceId
 * @property {object} [metadata]    identifiers and counts only
 *
 * @typedef {object} AuditLogPort
 * @property {(entry: AuditEntry) => Promise<void>} append
 * @property {(query: object) => Promise<{items: object[], nextCursor: string|null}>} query
 */

export {};
