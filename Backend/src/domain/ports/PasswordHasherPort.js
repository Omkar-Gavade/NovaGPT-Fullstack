/**
 * Password hashing, as a dependency.
 *
 * A port rather than a direct call so the algorithm can be replaced without
 * touching a use case — and so `needsRehash` has somewhere to live. Parameters
 * are raised over time as hardware improves; without a rehash-on-login path,
 * raising them protects only accounts created afterwards.
 *
 * @typedef {object} PasswordHasherPort
 * @property {(password: string) => Promise<string>} hash
 * @property {(hash: string, password: string) => Promise<boolean>} verify
 * @property {(hash: string) => boolean} needsRehash
 * @property {string} algorithm
 */

export {};
