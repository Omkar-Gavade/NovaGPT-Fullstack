import { ProviderState, ProviderStatus } from "../../../domain/provider/ProviderState.js";
import { FailureKind } from "../../../domain/errors/ProviderError.js";

/**
 * The fleet, and its live operational state.
 *
 * Holds every constructed adapter plus the `ProviderState` tracking whether it
 * may be used right now. This is the router's entire view of the world — and
 * the only place that knows a provider's health, latency, or breaker phase.
 *
 * What it deliberately does **not** own: routing decisions, prompts,
 * conversations, or what a model is good at. It answers "is this provider
 * usable?", never "should this provider be chosen?"
 * (docs/backend/03-provider-system.md#registry).
 *
 * Registration is dynamic in both directions. A provider can be added or
 * removed at runtime — needed for credential rotation, for an operator
 * disabling a provider during an incident, and for tests that build a fleet of
 * two.
 */
export class ProviderRegistry {
  /**
   * @param {object} deps
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} [deps.logger]
   * @param {import("../catalog/ModelRegistry.js").ModelRegistry} [deps.modelRegistry]
   * @param {number} [deps.failureThreshold]
   */
  constructor({ clock, logger, modelRegistry, failureThreshold = 3 }) {
    this.clock = clock;
    this.logger = logger;
    this.modelRegistry = modelRegistry;
    this.failureThreshold = failureThreshold;
    /** @type {Map<string, object>} */
    this.providers = new Map();
    /** @type {Map<string, ProviderState>} */
    this.states = new Map();
    /** Providers discovered but not constructed, and why. Kept for diagnosis. */
    this.skipped = new Map();
  }

  /* ----------------------------- registration ---------------------------- */

  /**
   * Add a provider and its models.
   *
   * Re-registering an existing id replaces it — that is how credential rotation
   * works — but the previous state is **discarded**, because a new instance has
   * not earned the old one's health record. Carrying it over would let a
   * provider with a fresh, untested key inherit a perfect score.
   */
  register(provider) {
    if (!provider?.id) throw new TypeError("A provider must have an id");

    if (this.providers.has(provider.id)) {
      this.logger?.info("providers.registry.replaced", { provider: provider.id });
      this.modelRegistry?.unregisterProvider(provider.id);
    }

    this.providers.set(provider.id, provider);
    this.states.set(
      provider.id,
      new ProviderState({
        providerId: provider.id,
        configured: provider.isConfigured,
        failureThreshold: this.failureThreshold,
      })
    );
    this.skipped.delete(provider.id);

    // Models are registered with the provider, so a provider's catalog cannot
    // outlive it and be routed to something that no longer exists.
    if (this.modelRegistry) {
      for (const model of provider.models ?? []) this.modelRegistry.register(model);
    }

    this.logger?.info("providers.registry.registered", {
      provider: provider.id,
      configured: provider.isConfigured,
      models: provider.models?.length ?? 0,
    });

    return provider;
  }

  /** Record a provider that exists but was not constructed, and why. */
  recordSkipped(descriptor, reason) {
    this.skipped.set(descriptor.id, { descriptor, reason });
    this.logger?.info("providers.registry.skipped", { provider: descriptor.id, reason });
  }

  unregister(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    this.states.get(providerId)?.stop();
    this.providers.delete(providerId);
    this.states.delete(providerId);
    this.modelRegistry?.unregisterProvider(providerId);
    this.logger?.info("providers.registry.unregistered", { provider: providerId });
    return true;
  }

  /* -------------------------------- lookup ------------------------------- */

  get(providerId) {
    return this.providers.get(providerId) ?? null;
  }

  has(providerId) {
    return this.providers.has(providerId);
  }

  state(providerId) {
    return this.states.get(providerId) ?? null;
  }

  all() {
    return [...this.providers.values()];
  }

  ids() {
    return [...this.providers.keys()];
  }

  get size() {
    return this.providers.size;
  }

  /** The provider serving a model id, or null. */
  forModel(modelId) {
    const model = this.modelRegistry?.get(modelId);
    return model ? this.get(model.provider) : null;
  }

  /* ------------------------------ availability --------------------------- */

  /** Configured, enabled, and not inside a breaker cooldown. */
  isAvailable(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider?.isConfigured) return false;
    return this.states.get(providerId)?.allowsRequest(this.clock.now()) ?? false;
  }

  /** Every provider the router may currently send work to. */
  available() {
    return this.all().filter((p) => this.isAvailable(p.id));
  }

  health(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider?.isConfigured) return 0;
    return this.states.get(providerId)?.health(this.clock.now()) ?? 0;
  }

  statusOf(providerId) {
    return this.states.get(providerId)?.status(this.clock.now()) ?? ProviderStatus.UNCONFIGURED;
  }

  averageLatencyMs(providerId) {
    return this.states.get(providerId)?.averageLatencyMs() ?? null;
  }

  /* ------------------------------- outcomes ------------------------------ */

  recordSuccess(providerId, latencyMs) {
    this.states.get(providerId)?.recordSuccess(latencyMs, this.clock.now());
  }

  recordFailure(providerId, error) {
    const state = this.states.get(providerId);
    if (!state) return;
    const before = state.phase;
    const kind = error?.failureKind ?? error?.kind ?? FailureKind.API_ERROR;
    state.recordFailure(kind, this.clock.now(), error);

    // Logged as a *transition*, not as an error. A quota failure is normal
    // operation on a free tier; the breaker opening is the event an operator
    // cares about (docs/backend/11-observability.md#levels-with-explicit-criteria).
    if (before !== state.phase) {
      this.logger?.warn("providers.registry.phase_changed", {
        provider: providerId,
        from: before,
        to: state.phase,
        kind,
        cooldownMs: state.cooldownRemainingMs(this.clock.now()),
      });
    }
  }

  /* ----------------------------- operator control ------------------------ */

  /**
   * Take a provider out of rotation without destroying it.
   *
   * Draining rather than unregistering is what lets an operator disable a
   * provider mid-incident — for a key rotation or a terms change — with zero
   * user-visible errors: in-flight work finishes, nothing new is admitted
   * (docs/backend/03-provider-system.md#provider-lifecycle).
   */
  disable(providerId) {
    return this.states.get(providerId)?.drain() ?? false;
  }

  /** Re-enable. Returns to unproven, not to healthy — it has to earn that back. */
  enable(providerId) {
    return this.states.get(providerId)?.resume() ?? false;
  }

  /* ------------------------------- snapshot ------------------------------ */

  /** Never leaks a credential, a base URL, or any other operational detail. */
  snapshot() {
    const now = this.clock.now();
    const registered = this.all().map((provider) => ({
      ...provider.toJSON(),
      ...this.states.get(provider.id).snapshot(now),
    }));
    const skipped = [...this.skipped.values()].map(({ descriptor, reason }) => ({
      ...descriptor.toJSON(),
      status: ProviderStatus.UNCONFIGURED,
      available: false,
      reason,
    }));
    return { registered, skipped, total: registered.length + skipped.length };
  }
}
