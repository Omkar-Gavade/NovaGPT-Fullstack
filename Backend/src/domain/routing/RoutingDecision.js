/**
 * The routing policy's entire output.
 *
 * It carries its own rationale. "Why did my request go to Groq?" is the most
 * common operational question in a multi-provider system, and without a
 * recorded reason answering it means reconstructing the state of eight
 * providers at a past moment — which is impossible
 * (docs/backend/04-router.md#the-decision-object).
 *
 * Fallbacks are computed **up front**, against the same health snapshot as the
 * primary, so the whole chain is ranked against one consistent view of the
 * world. Computing them lazily on failure would rank a fallback against a
 * different world-state than the primary and make failover irreproducible.
 */

/** Why a model was rejected. Kept small and structured so it can be logged. */
export class RejectionReason {
  constructor({ modelId, provider, reason, unmet = [] }) {
    this.modelId = modelId;
    this.provider = provider;
    this.reason = reason;
    this.unmet = Object.freeze([...unmet]);
    Object.freeze(this);
  }

  toJSON() {
    return {
      modelId: this.modelId,
      reason: this.reason,
      ...(this.unmet.length ? { unmet: this.unmet } : {}),
    };
  }
}

export const RoutingMode = {
  /** The user pinned a model and it is usable. */
  PINNED: "pinned",
  /** No preference; ranked automatically. */
  AUTOMATIC: "automatic",
  /** Automatic, restricted by derived hard requirements. */
  CONSTRAINED: "constrained",
  /** The pin was unusable, so ranking chose instead. */
  OVERRIDDEN: "overridden",
};

export class RoutingDecision {
  /**
   * @param {object} raw
   * @param {import("../capability/ModelDescriptor.js").ModelDescriptor} raw.primary
   * @param {import("../capability/ModelDescriptor.js").ModelDescriptor[]} [raw.fallbacks]
   * @param {string} raw.reason           human-readable
   * @param {string} raw.mode             one of RoutingMode
   * @param {import("../capability/RequirementSet.js").RequirementSet} raw.requirements
   * @param {number} raw.consideredCount  how many models were eligible
   * @param {RejectionReason[]} [raw.rejected]
   */
  constructor({
    primary,
    fallbacks = [],
    reason,
    mode,
    requirements,
    consideredCount = 0,
    rejected = [],
  }) {
    this.primary = primary;
    this.fallbacks = Object.freeze([...fallbacks]);
    this.reason = reason;
    this.mode = mode;
    this.requirements = requirements;
    this.consideredCount = consideredCount;
    // Capped by the policy before it reaches here — an exhaustive rejection
    // list on a large catalog is a log line nobody reads and a cost everybody
    // pays.
    this.rejected = Object.freeze([...rejected]);
    Object.freeze(this);
  }

  /** The full attempt order: primary first, then fallbacks. */
  get chain() {
    return [this.primary, ...this.fallbacks];
  }

  /** The model for attempt N (0-based), or null when the chain is exhausted. */
  attempt(index) {
    return this.chain[index] ?? null;
  }

  get maxAttempts() {
    return this.chain.length;
  }

  /** Compact form for the `routing.decided` log line. */
  toLog() {
    return {
      model: this.primary.id,
      provider: this.primary.provider,
      mode: this.mode,
      reason: this.reason,
      fallbacks: this.fallbacks.map((m) => m.id),
      consideredCount: this.consideredCount,
      requirements: this.requirements?.toJSON?.() ?? {},
      ...(this.rejected.length ? { rejected: this.rejected.map((r) => r.toJSON()) } : {}),
    };
  }
}
