/**
 * The model catalog, joined with live provider state.
 *
 * Availability is embedded in the catalog rather than served separately: the
 * client needs both on every render, and two endpoints would mean two round
 * trips plus a window in which they disagree
 * (docs/backend/09-api-design.md#models-and-providers).
 */
export class CatalogService {
  constructor({ modelRegistry, providerRegistry, costTable }) {
    this.modelRegistry = modelRegistry;
    this.providerRegistry = providerRegistry;
    this.costTable = costTable;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.includeUnconfigured] admin view only
   */
  listModels({ includeUnconfigured = false } = {}) {
    const models = this.modelRegistry.all().filter((model) => {
      if (includeUnconfigured) return true;
      // Which providers a deployment holds keys for is operational information:
      // exposing it tells an attacker what to target and tells users about
      // capabilities they cannot use.
      return this.providerRegistry.has(model.provider);
    });

    return {
      data: models.map((model) => ({
        id: model.id,
        provider: model.provider,
        providerName: this.providerRegistry.get(model.provider)?.name ?? model.provider,
        displayName: model.displayName,
        capabilities: model.capabilities.toJSON(),
        limits: {
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        },
        economics: { tier: model.tier, costBand: model.costBand },
        status: this.providerRegistry.statusOf(model.provider),
        available: this.providerRegistry.isAvailable(model.provider),
        latencyMs: this.providerRegistry.averageLatencyMs(model.provider),
        deprecated: model.deprecated,
        replacedBy: model.replacedBy,
      })),
      meta: {
        catalogVersion: this.modelRegistry.version,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /** Provider status. Never leaks a credential, base URL, or endpoint. */
  listProviders() {
    return this.providerRegistry.snapshot();
  }
}
