/**
 * Owns the provider fleet's lifecycle.
 *
 * Discovery finds adapters, the loader imports them, the factory constructs
 * them, the registry holds them, and the health manager watches them. Each of
 * those has one job and none of them knows the sequence. This is the only place
 * that knows the sequence.
 *
 * Application layer, not infrastructure: it is orchestration with a defined
 * order and defined failure semantics — exactly what a use case is
 * (docs/backend/02-architecture.md#why-the-application-layer-exists-at-all).
 *
 * ## Startup is deliberately forgiving
 *
 * A broken adapter, a missing credential, or an invalid model row degrades the
 * fleet; none of them stops the platform. A deployment with zero configured
 * providers still boots and still serves health and metrics — the operator sees
 * exactly which providers were skipped and why, at boot, rather than
 * discovering it through a routing failure later.
 */
export class ProviderManager {
  /**
   * @param {object} deps
   * @param {import("../../infrastructure/providers/registry/ProviderDiscovery.js").ProviderDiscovery} deps.discovery
   * @param {import("../../infrastructure/providers/registry/ProviderLoader.js").ProviderLoader} deps.loader
   * @param {import("../../infrastructure/providers/registry/ProviderFactory.js").ProviderFactory} deps.factory
   * @param {import("../../infrastructure/providers/registry/ProviderRegistry.js").ProviderRegistry} deps.registry
   * @param {import("../../infrastructure/providers/health/ProviderHealthManager.js").ProviderHealthManager} deps.health
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   */
  constructor({ discovery, loader, factory, registry, health, logger }) {
    this.discovery = discovery;
    this.loader = loader;
    this.factory = factory;
    this.registry = registry;
    this.health = health;
    this.logger = logger?.child?.({ component: "providers" }) ?? logger;
    this.started = false;
  }

  /**
   * Discover, load, construct, register.
   *
   * @returns {Promise<{registered: string[], skipped: object[], failed: object[]}>}
   */
  async start() {
    if (this.started) return this.summary();

    const candidates = await this.discovery.discover();
    const { loaded, failed } = await this.loader.loadAll(candidates);

    const registered = [];
    const skipped = [];

    for (const { descriptor, Adapter } of loaded) {
      const { provider, reason } = this.factory.create(descriptor, Adapter);
      if (provider) {
        this.registry.register(provider);
        registered.push(provider.id);
      } else {
        // Not an error path. A provider without a key is skipped by design, and
        // the reason is what turns a silent absence into a fixable message.
        this.registry.recordSkipped(descriptor, reason);
        skipped.push({ id: descriptor.id, reason });
      }
    }

    this.health.start();
    this.started = true;

    this.logger?.info("providers.started", {
      discovered: candidates.length,
      registered: registered.length,
      skipped: skipped.length,
      failed: failed.length,
    });

    if (registered.length === 0) {
      // Loud, because everything downstream will fail in a way that looks like
      // a different problem.
      this.logger?.warn("providers.none_configured", {
        impact: "no provider is available to serve a request",
        skipped: skipped.map((s) => s.id),
      });
    }

    return { registered, skipped, failed: failed.map((f) => ({ id: f.id, error: f.error.message })) };
  }

  /**
   * Register a provider built elsewhere.
   *
   * The dynamic-registration entry point. Used by tests, and by any future path
   * that constructs a provider outside discovery — a user-supplied endpoint,
   * for example.
   */
  register(provider) {
    return this.registry.register(provider);
  }

  unregister(providerId) {
    return this.registry.unregister(providerId);
  }

  /* ------------------------------ operator API --------------------------- */

  /** Take out of rotation; in-flight work finishes. */
  disable(providerId) {
    const ok = this.registry.disable(providerId);
    if (ok) this.logger?.info("providers.disabled", { provider: providerId });
    return ok;
  }

  enable(providerId) {
    const ok = this.registry.enable(providerId);
    if (ok) this.logger?.info("providers.enabled", { provider: providerId });
    return ok;
  }

  /* -------------------------------- queries ------------------------------ */

  get(providerId) {
    return this.registry.get(providerId);
  }

  available() {
    return this.registry.available();
  }

  summary() {
    return this.registry.snapshot();
  }

  async checkHealth() {
    return this.health.probeAll();
  }

  /**
   * Stop the health monitor and drain every provider.
   *
   * Draining rather than unregistering: the process is shutting down, and
   * in-flight requests should finish rather than be cut off
   * (docs/backend/13-deployment.md#graceful-shutdown).
   */
  async stop() {
    this.health.stop();
    for (const id of this.registry.ids()) this.registry.disable(id);
    this.started = false;
    this.logger?.info("providers.stopped");
  }
}
