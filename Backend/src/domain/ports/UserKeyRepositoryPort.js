/**
 * User-supplied provider keys, as a dependency.
 *
 * Every method takes the owner. Scoping at the query is what makes a forgotten
 * check return nothing rather than someone else's credential — the same
 * reasoning as `ThreadRepositoryPort`, with a far worse failure mode
 * (docs/backend/10-security.md#rules-for-user-supplied-keys).
 *
 * `remove` really removes. Deletion of a credential must be immediate and
 * complete, so there is no soft-delete here and no undo window: a key the user
 * asked us to forget must not be recoverable from a backup taken afterwards.
 *
 * @typedef {object} UserKeyRepositoryPort
 * @property {(userId: string, provider: string) => Promise<import("../identity/UserProviderKey.js").UserProviderKey|null>} find
 * @property {(userId: string) => Promise<import("../identity/UserProviderKey.js").UserProviderKey[]>} listForUser
 * @property {(record: object) => Promise<void>} save
 * @property {(userId: string, provider: string) => Promise<boolean>} remove
 */

export {};
