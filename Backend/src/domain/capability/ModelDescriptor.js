import { CapabilitySet } from "./CapabilitySet.js";
import { capabilityRegistry } from "./CapabilityRegistry.js";
import { Tier, CostBand } from "./Capability.js";

/**
 * One routable model, validated and immutable.
 *
 * The shape is the schema in
 * docs/backend/05-capability-matrix.md#model-descriptor-schema. Validation is
 * strict because a wrong capability flag causes user-visible failures the
 * router cannot prevent, silently, until someone notices — matrix bugs get the
 * same severity as code bugs.
 */
export class ModelDescriptor {
  constructor(raw = {}, registry = capabilityRegistry) {
    const problems = [];
    if (!raw.id) problems.push("id is required");
    if (!raw.provider) problems.push("provider is required");
    if (raw.tier && !Object.values(Tier).includes(raw.tier)) {
      problems.push(`tier must be one of ${Object.values(Tier).join(", ")}`);
    }
    if (raw.costBand && !CostBand.includes(raw.costBand)) {
      problems.push(`costBand must be one of ${CostBand.join(", ")}`);
    }
    if (problems.length) {
      throw new TypeError(`Invalid model "${raw.id ?? "?"}": ${problems.join("; ")}`);
    }

    this.id = raw.id;
    this.provider = raw.provider;
    this.displayName = raw.displayName ?? raw.id;
    // Throws on an unknown axis or a wrong-typed value, so a catalog typo is a
    // startup failure rather than a mis-route.
    this.capabilities = new CapabilitySet(raw.capabilities ?? {}, registry);
    this.tier = raw.tier ?? Tier.PAID;
    this.costBand = raw.costBand ?? "$$";
    this.deprecated = raw.deprecated === true;
    this.replacedBy = raw.replacedBy ?? null;
    this.notes = raw.notes ?? null;
    // Capability data rots: a provider changes a window and nothing notices.
    // A timestamp lets a periodic audit list everything unverified recently.
    this.verifiedAt = raw.verifiedAt ?? null;
    Object.freeze(this);
  }

  get contextWindow() {
    return this.capabilities.value("contextWindow");
  }

  get maxOutputTokens() {
    return this.capabilities.value("maxOutputTokens");
  }

  get isFree() {
    return this.tier === Tier.FREE;
  }

  supports(capability) {
    return this.capabilities.supports(capability);
  }

  /** Whether this model may be chosen automatically. Deprecated models may not. */
  get isSelectable() {
    return !this.deprecated;
  }

  toJSON() {
    return {
      id: this.id,
      provider: this.provider,
      displayName: this.displayName,
      capabilities: this.capabilities.toJSON(),
      tier: this.tier,
      costBand: this.costBand,
      deprecated: this.deprecated,
      replacedBy: this.replacedBy,
      notes: this.notes,
      verifiedAt: this.verifiedAt,
    };
  }
}
