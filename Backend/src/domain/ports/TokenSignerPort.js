/**
 * Token signing and verification, as a dependency.
 *
 * `verify` **never throws for an invalid token** — it returns a result object.
 * An expired token is the single most common thing this function sees, and
 * exceptions for the common case make every call site a try/catch that
 * eventually swallows something it should not have.
 *
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {object|null} claims
 * @property {"expired"|"signature"|"malformed"|"issuer"|"audience"|"type"|null} reason
 *
 * @typedef {object} TokenSignerPort
 * @property {(claims: object, ttlMs: number) => string} sign
 * @property {(token: string) => VerifyResult} verify
 * @property {string} algorithm
 * @property {string} keyId
 */

export {};
