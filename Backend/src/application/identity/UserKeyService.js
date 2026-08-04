import { Secret } from "../../infrastructure/telemetry/Secret.js";
import { UserProviderKey } from "../../domain/identity/UserProviderKey.js";
import { EnvelopeCipher } from "../../infrastructure/security/EnvelopeCipher.js";
import { AppError, ErrorKind } from "../../domain/errors/index.js";
import { FailureKind } from "../../domain/errors/ProviderError.js";

/**
 * Bring-your-own-key: storing, validating, resolving and forgetting a user's
 * provider credentials.
 *
 * The four rules from
 * [10](../../../docs/backend/10-security.md#rules-for-user-supplied-keys), and
 * where each one lives:
 *
 * | Rule | Here |
 * |---|---|
 * | Validated with a cheap probe on submission | `store()` calls the provider before writing |
 * | Write-only through the API | Nothing returns the envelope; `toPublicJSON` has no field for it |
 * | Deletable, immediately and completely | `forget()` removes the row rather than flagging it |
 * | Never used for another user's request | `resolve()` takes the owner and scopes the query |
 *
 * The fifth rule is enforced in the router rather than here, and it is the one
 * most easily missed: **a failure against a user's key must not open the shared
 * breaker.** One user pasting an expired key would otherwise take a provider
 * out of rotation for everyone.
 */
export class UserKeyService {
  constructor({ keys, cipher, registry, clock, logger, audit }) {
    this.keys = keys;
    // Null when no master key is configured. Encrypting under a key that dies
    // with the process would be worse than refusing the feature, so the
    // absence is a refusal rather than a fallback.
    this.cipher = cipher;
    this.registry = registry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "user-keys" }) ?? logger;
    this.audit = audit;
  }

  get enabled() {
    return Boolean(this.cipher);
  }

  #assertEnabled() {
    if (!this.enabled) {
      throw new AppError(
        "This deployment cannot store provider keys: no encryption key is configured.",
        ErrorKind.FORBIDDEN,
        { details: { fix: "set ENCRYPTION_MASTER_KEY" } }
      );
    }
  }

  /**
   * Store a key, after proving it works.
   *
   * **Validated before it is written, not after.** A key that fails at first
   * use produces a confusing experience the user attributes to the platform
   * rather than to their key — and by then it is already stored, so the next
   * request fails the same way.
   */
  async store({ userId, provider: providerId, key, context = {} }) {
    this.#assertEnabled();

    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new AppError(`Unknown provider: ${providerId}`, ErrorKind.NOT_FOUND, {
        field: "provider",
      });
    }

    const plaintext = String(key ?? "").trim();
    if (plaintext.length < 8) {
      throw new AppError("That does not look like an API key.", ErrorKind.VALIDATION, {
        field: "key",
      });
    }

    await this.#probe(provider, plaintext);

    const now = this.clock.now();
    const existing = await this.keys.find(userId, providerId);

    const record = new UserProviderKey({
      userId,
      provider: providerId,
      envelope: this.cipher.encrypt(plaintext),
      mask: EnvelopeCipher.mask(plaintext),
      createdAt: existing?.createdAt?.toISOString() ?? new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      // It just validated, by definition — the probe above is what got us here.
      lastValidatedAt: new Date(now).toISOString(),
    });

    await this.keys.save(record);

    // The action, never the value (docs/backend/10-security.md#audit-logging).
    await this.audit?.append({
      action: "key.added",
      outcome: "success",
      actorId: userId,
      actorIp: context.ip ?? null,
      resourceType: "provider_key",
      resourceId: providerId,
      traceId: context.traceId ?? null,
      metadata: { mask: record.mask },
    });

    return record;
  }

  /** Masked, always. There is no code path that returns a stored key. */
  async list(userId) {
    const records = await this.keys.listForUser(userId);
    return records.map((record) => record.toPublicJSON());
  }

  async forget({ userId, provider, context = {} }) {
    const removed = await this.keys.remove(userId, provider);
    if (!removed) throw new AppError("No key stored for that provider.", ErrorKind.NOT_FOUND);

    await this.audit?.append({
      action: "key.deleted",
      outcome: "success",
      actorId: userId,
      actorIp: context.ip ?? null,
      resourceType: "provider_key",
      resourceId: provider,
      traceId: context.traceId ?? null,
    });
    return true;
  }

  /**
   * Every key this user holds, decrypted, for one request.
   *
   * Returns a `Map<providerId, Secret>` so the value is wrapped the moment it
   * leaves storage: an accidental log line produces `[REDACTED:BYOK]`.
   *
   * Loaded once per request rather than per attempt, because a failover would
   * otherwise decrypt again — and each decryption is a use of the master key.
   */
  async resolve(userId) {
    if (!userId || !this.enabled) return new Map();

    const records = await this.keys.listForUser(userId);
    const resolved = new Map();

    for (const record of records) {
      try {
        resolved.set(record.provider, new Secret(this.cipher.decrypt(record.envelope), "BYOK"));
      } catch (error) {
        // A record that will not decrypt is a rotated master key or a tampered
        // row. Skipping it degrades the user to the platform key, which is a
        // better outcome than failing their request — and it is logged, because
        // it should never happen quietly.
        this.logger?.error("user_keys.decrypt_failed", {
          userId,
          provider: record.provider,
          error,
        });
      }
    }
    return resolved;
  }

  /** Record that a stored key was rejected, so the user can be told. */
  async markRejected(userId, provider) {
    const record = await this.keys.find(userId, provider);
    if (!record) return;
    await this.keys.save(record.rejected(this.clock.now()));
    this.logger?.warn("user_keys.rejected", { userId, provider });
  }

  /**
   * A cheap call that proves the key works.
   *
   * Uses the provider's own health probe with the candidate credential, so it
   * costs a liveness sample rather than a completion.
   */
  async #probe(provider, plaintext) {
    const credential = new Secret(plaintext, "BYOK");
    let result;
    try {
      result = await provider.health({ credential });
    } catch (error) {
      if (error?.failureKind === FailureKind.AUTH) throw rejected(provider.name);
      // Anything else is the provider being unreachable, which says nothing
      // about the key. Storing it would be wrong; so would blaming the user.
      throw new AppError(
        `Could not reach ${provider.name} to check that key. Try again shortly.`,
        ErrorKind.PROVIDER_UNAVAILABLE,
        { expected: true }
      );
    }
    if (!result?.ok) throw rejected(provider.name);
  }
}

const rejected = (providerName) =>
  new AppError(`${providerName} rejected that key.`, ErrorKind.VALIDATION, {
    field: "key",
    expected: true,
  });
