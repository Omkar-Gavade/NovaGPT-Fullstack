import { ModelDescriptor } from "../../../domain/capability/ModelDescriptor.js";
import { Secret } from "../../telemetry/Secret.js";

/**
 * Construct provider instances from descriptors and configuration.
 *
 * One job: decide whether a provider *can* be built, and build it.
 *
 * Adapters do not read `process.env` in their constructors. That is the
 * difference this class exists to make (docs/backend/03-provider-system.md#factory-pattern):
 *
 *   - **Testable.** The whole fleet can be constructed with fake credentials in
 *     one call. Adapters reading env require mutating global state in tests,
 *     which makes tests order-dependent.
 *   - **One validation point.** Credentials are checked at boot with a readable
 *     message, rather than failing inside a request at 3am.
 *   - **Precedence becomes expressible.** Env, then config file, then default,
 *     with per-provider overrides — in one place instead of eight.
 *   - **Multiple instances become possible.** Two keys for one provider, or a
 *     regional endpoint alongside a global one, is a factory concern. An
 *     adapter reading env can only ever be a singleton.
 */
export class ProviderFactory {
  /**
   * @param {object} deps
   * @param {object} deps.providerConfig  per-provider settings from config
   * @param {Record<string,string|undefined>} deps.env  credential source
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../../domain/capability/CapabilityRegistry.js").CapabilityRegistry} [deps.capabilityRegistry]
   */
  constructor({
    providerConfig = {},
    policy = {},
    env = {},
    logger,
    clock,
    capabilityRegistry,
  }) {
    this.providerConfig = providerConfig;
    this.allowlist = policy.allowlist ?? null;
    this.denylist = policy.denylist ?? [];
    this.env = env;
    this.logger = logger;
    this.clock = clock;
    this.capabilityRegistry = capabilityRegistry;
  }

  /**
   * Configuration for one provider, with documented defaults.
   *
   * Precedence: denylist beats allowlist beats per-provider config beats the
   * default. The denylist wins outright so that an operator taking a provider
   * out during an incident cannot be overridden by a stale allowlist someone
   * configured months earlier.
   */
  configFor(providerId) {
    const config = this.providerConfig[providerId] ?? {};

    let enabled = config.enabled !== false; // enabled by default
    let reason = null;

    if (this.allowlist && !this.allowlist.includes(providerId)) {
      enabled = false;
      reason = "not in PROVIDERS_ENABLED";
    }
    if (this.denylist.includes(providerId)) {
      enabled = false;
      reason = "listed in PROVIDERS_DISABLED";
    }
    if (!enabled && !reason) reason = "disabled by configuration";

    return { ...config, enabled, reason, settings: config.settings ?? {} };
  }

  /**
   * Resolve a credential from the descriptor's declared variables.
   *
   * First match wins, so an adapter can accept an alias (`KIMI_API_KEY` or
   * `MOONSHOT_API_KEY`) without special-casing anywhere else. The value is
   * wrapped in `Secret` immediately — before it is stored, logged, or passed —
   * so the naive thing produces a redaction rather than a key
   * (docs/backend/10-security.md#structural-defences-against-leakage-t1).
   */
  credentialFor(descriptor) {
    for (const key of descriptor.envKeys) {
      const value = this.env[key]?.trim();
      if (value) return new Secret(value, key);
    }
    return null;
  }

  /**
   * Build the models this provider serves.
   *
   * A model that fails validation is dropped, not fatal. One bad catalog row
   * must not remove an otherwise working provider — but it is logged at error
   * level, because a capability typo is a bug with the same severity as a code
   * defect (docs/backend/05-capability-matrix.md#maintaining-the-matrix).
   */
  modelsFor(descriptor) {
    const models = [];
    for (const raw of descriptor.models) {
      try {
        models.push(new ModelDescriptor({ ...raw, provider: descriptor.id }, this.capabilityRegistry));
      } catch (error) {
        this.logger?.error("providers.factory.invalid_model", {
          provider: descriptor.id,
          model: raw?.id,
          error,
        });
      }
    }
    return models;
  }

  /**
   * @returns {{provider: object|null, reason: string|null, configured: boolean}}
   *   `provider: null` with a reason is a normal outcome, not a failure — a
   *   provider with no key is simply skipped, and the reason is what makes that
   *   visible at boot instead of mysterious at request time.
   */
  create(descriptor, Adapter) {
    const config = this.configFor(descriptor.id);

    if (!config.enabled) {
      return { provider: null, reason: config.reason, configured: false };
    }

    const credential = this.credentialFor(descriptor);
    const configured = descriptor.requiresCredentials ? Boolean(credential) : true;

    if (!configured) {
      return {
        provider: null,
        reason: `no credential (set one of: ${descriptor.envKeys.join(", ") || "none declared"})`,
        configured: false,
      };
    }

    try {
      const provider = new Adapter({
        descriptor,
        models: this.modelsFor(descriptor),
        logger: this.logger,
        clock: this.clock,
        credential,
        settings: config.settings,
      });
      return { provider, reason: null, configured: true };
    } catch (error) {
      this.logger?.error("providers.factory.construction_failed", {
        provider: descriptor.id,
        error,
      });
      return { provider: null, reason: `construction failed: ${error.message}`, configured };
    }
  }
}
