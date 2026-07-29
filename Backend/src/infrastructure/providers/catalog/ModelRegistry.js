import { ModelDescriptor } from "../../../domain/capability/ModelDescriptor.js";
import { capabilityRegistry } from "../../../domain/capability/CapabilityRegistry.js";

/**
 * The model catalog — every model NovaGPT can route to.
 *
 * Lives in `infrastructure/` rather than `domain/` because it is a *data
 * source*: today a file, tomorrow possibly a table or a remote config service.
 * The domain owns the `ModelDescriptor` type and the matching logic; where the
 * rows come from is an infrastructure concern
 * (docs/backend/16-repository-structure.md).
 *
 * Registration is dynamic. An adapter contributes its own models when it loads,
 * so adding a provider adds rows without editing a central list — which is what
 * makes "create adapter, register adapter, nothing else" literally true.
 */
export class ModelRegistry {
  constructor({ registry = capabilityRegistry } = {}) {
    this.capabilityRegistry = registry;
    /** @type {Map<string, ModelDescriptor>} */
    this.models = new Map();
    /**
     * Bumped on every mutation and exposed to clients so a cached catalog can
     * be invalidated. A stale capability cache silently misroutes requests
     * (docs/backend/03-provider-system.md#versioning).
     */
    this.version = 0;
  }

  /**
   * Add or replace a model.
   *
   * Replacement is allowed — a provider reloading its catalog must be able to
   * correct a row — but a *different provider* claiming an existing id is
   * rejected. Two providers silently fighting over one model id would make
   * routing non-deterministic in a way no log would explain.
   */
  register(raw) {
    const model = raw instanceof ModelDescriptor ? raw : new ModelDescriptor(raw, this.capabilityRegistry);
    const existing = this.models.get(model.id);
    if (existing && existing.provider !== model.provider) {
      throw new Error(
        `Model "${model.id}" is already registered to provider "${existing.provider}"`
      );
    }
    this.models.set(model.id, model);
    this.version += 1;
    return model;
  }

  registerAll(rows = []) {
    return rows.map((row) => this.register(row));
  }

  /**
   * Drop every model belonging to a provider.
   * Used when a provider is unregistered, so its models cannot outlive it and
   * be routed to something that no longer exists.
   */
  unregisterProvider(providerId) {
    let removed = 0;
    for (const [id, model] of this.models) {
      if (model.provider === providerId) {
        this.models.delete(id);
        removed += 1;
      }
    }
    if (removed) this.version += 1;
    return removed;
  }

  get(modelId) {
    return this.models.get(modelId) ?? null;
  }

  has(modelId) {
    return this.models.has(modelId);
  }

  get size() {
    return this.models.size;
  }

  all() {
    return [...this.models.values()];
  }

  forProvider(providerId) {
    return this.all().filter((m) => m.provider === providerId);
  }

  /** Models that may be chosen automatically — deprecated ones are excluded. */
  selectable() {
    return this.all().filter((m) => m.isSelectable);
  }

  /**
   * Models satisfying every requirement.
   *
   * A hard filter, not a score. Deprecated models are excluded from automatic
   * selection but remain retrievable by id, so a conversation pinned to a
   * retired model keeps working instead of failing with "unknown model"
   * (docs/backend/05-capability-matrix.md#maintaining-the-matrix).
   *
   * @param {import("../../../domain/capability/RequirementSet.js").RequirementSet} requirements
   */
  matching(requirements) {
    return this.selectable().filter((m) => requirements.satisfiedBy(m.capabilities));
  }

  /**
   * Why each model failed a requirement set.
   *
   * The diagnostic *is* the value when nothing matches: it turns "no model
   * available" into "the largest context window available is 256K tokens".
   */
  explainMismatch(requirements) {
    return this.selectable()
      .map((m) => ({ modelId: m.id, unmet: requirements.unmetBy(m.capabilities) }))
      .filter((r) => r.unmet.length > 0);
  }

  /** The best value any model offers on a numeric axis, for error messages. */
  bestNumeric(capability) {
    let best = null;
    for (const model of this.selectable()) {
      const value = model.capabilities.value(capability);
      if (Number.isFinite(value) && (best === null || value > best.value)) {
        best = { value, modelId: model.id, provider: model.provider };
      }
    }
    return best;
  }

  /** Providers offering a binary capability — the failover-coverage question. */
  providersSupporting(capability) {
    return [
      ...new Set(this.selectable().filter((m) => m.supports(capability)).map((m) => m.provider)),
    ];
  }

  snapshot() {
    return { version: this.version, count: this.models.size, models: this.all().map((m) => m.toJSON()) };
  }
}
