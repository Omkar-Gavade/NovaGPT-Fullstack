/**
 * Account persistence, as a dependency.
 *
 * `findByEmail` takes an already-normalised address. Normalisation belongs to
 * the domain (`Credentials.normaliseEmail`), not to each implementation — two
 * stores that fold case differently would let the same person hold two
 * accounts in one deployment and one in another.
 *
 * @typedef {object} UserRepositoryPort
 * @property {(id: string) => Promise<import("../identity/User.js").User|null>} findById
 * @property {(email: string) => Promise<import("../identity/User.js").User|null>} findByEmail
 * @property {(user: object) => Promise<import("../identity/User.js").User>} save
 * @property {(email: string) => Promise<boolean>} exists
 * @property {() => Promise<number>} count
 */

export {};
