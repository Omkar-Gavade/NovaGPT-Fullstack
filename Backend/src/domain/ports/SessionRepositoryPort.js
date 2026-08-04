/**
 * Refresh-token sessions, as a dependency.
 *
 * `revokeFamily` exists because reuse detection is a family-level action: a
 * replayed token proves the family is compromised, and revoking only the
 * replayed token would leave the thief's *next* token working
 * (docs/backend/10-security.md#authentication).
 *
 * @typedef {object} SessionRepositoryPort
 * @property {(id: string) => Promise<import("../identity/Session.js").Session|null>} findById
 * @property {(session: object) => Promise<import("../identity/Session.js").Session>} save
 * @property {(familyId: string, now: Date) => Promise<number>} revokeFamily  returns sessions revoked
 * @property {(userId: string, now: Date) => Promise<number>} revokeAllForUser
 * @property {(cutoff: Date) => Promise<number>} purgeExpiredBefore
 */

export {};
