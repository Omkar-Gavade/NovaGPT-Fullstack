import { HealthSnapshot } from "../../domain/routing/HealthSnapshot.js";

/**
 * Turns live registry state into the frozen snapshot the policy consumes.
 *
 * The seam between mutable infrastructure and pure domain. The registry is a
 * living object whose state changes under concurrent requests; the policy needs
 * an immutable view. This adapter is where that conversion happens, and it is
 * the reason the policy never has to know a registry exists.
 *
 * One snapshot is taken **per request**, not per attempt. A failover ranked
 * against fresher state than its primary would be ranked against a different
 * world, and the resulting decision would be irreproducible from the logs.
 */
export class RegistrySnapshotSource {
  /**
   * @param {object} deps
   * @param {import("../providers/registry/ProviderRegistry.js").ProviderRegistry} deps.registry
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {Record<string, number>} [deps.priorities] operator bias per provider
   */
  constructor({ registry, clock, priorities = {} }) {
    this.registry = registry;
    this.clock = clock;
    this.priorities = priorities;
  }

  /** @returns {HealthSnapshot} */
  capture() {
    const now = this.clock.now();
    const entries = this.registry.all().map((provider) => ({
      providerId: provider.id,
      available: this.registry.isAvailable(provider.id),
      health: this.registry.health(provider.id),
      latencyMs: this.registry.averageLatencyMs(provider.id),
      status: this.registry.statusOf(provider.id),
      priority: this.priorities[provider.id] ?? 0,
    }));
    return new HealthSnapshot(entries, now);
  }
}
