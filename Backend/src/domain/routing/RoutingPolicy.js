import { RoutingDecision, RejectionReason, RoutingMode } from "./RoutingDecision.js";
import { buildComparator, explainWinner } from "./RankingCriteria.js";
import { AppError, ErrorKind } from "../errors/index.js";

/**
 * The routing engine. Pure.
 *
 * Given a catalog, a requirement set, a health snapshot, and an optional user
 * preference, it returns an ordered candidate chain and the reasoning behind
 * it. No I/O, no clock, no registry, no provider names — a model is data and a
 * provider is an id.
 *
 * Purity is the whole point: this is the component with the subtlest logic in
 * the system, and it must be exhaustively testable. Every row of the decision
 * table in docs/backend/04-router.md#every-routing-decision-enumerated is a
 * unit test that runs in microseconds with no fixtures.
 *
 * **Selection is a hard filter followed by a lexicographic sort.** Requirements
 * are binary, so they gate; everything else orders
 * (docs/backend/04-router.md#ranking).
 */

/** Near-misses recorded per decision. Bounded so a large catalog stays loggable. */
const MAX_REJECTIONS_RECORDED = 5;

/** One primary plus two fallbacks (docs/backend/04-router.md#failover-budget). */
const DEFAULT_MAX_CANDIDATES = 3;

export class RoutingPolicy {
  /**
   * @param {object} [options]
   * @param {number} [options.maxCandidates] length of the returned chain
   */
  constructor({ maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
    this.maxCandidates = maxCandidates;
  }

  /**
   * @param {object} input
   * @param {import("../capability/ModelDescriptor.js").ModelDescriptor[]} input.catalog
   * @param {import("../capability/RequirementSet.js").RequirementSet} input.requirements
   * @param {import("./HealthSnapshot.js").HealthSnapshot} input.snapshot
   * @param {string} [input.preferredModelId] the user's pin
   * @param {string[]} [input.exclude] provider ids already tried this request
   * @returns {RoutingDecision}
   * @throws {AppError} when nothing can serve the request — the error names the
   *         specific constraint, because the diagnostic *is* the value here.
   */
  decide({ catalog, requirements, snapshot, preferredModelId = null, exclude = [] }) {
    const context = new RankingContext({ catalog, requirements, snapshot });
    const rejected = [];

    /* ---- 1. Hard filter: capability, then availability ------------------ */

    const eligible = [];
    for (const model of catalog) {
      if (!model.isSelectable) {
        // Deprecated models remain retrievable by id (so a pinned conversation
        // keeps working) but never win automatic selection.
        record(rejected, model, "deprecated");
        continue;
      }
      if (exclude.includes(model.provider)) {
        record(rejected, model, "already attempted this request");
        continue;
      }
      const unmet = requirements.unmetBy(model.capabilities);
      if (unmet.length) {
        record(rejected, model, "capability requirements not met", unmet);
        continue;
      }
      if (!snapshot.isAvailable(model.provider)) {
        record(rejected, model, `provider ${snapshot.get(model.provider).status}`);
        continue;
      }
      eligible.push(model);
    }

    /* ---- 2. Honour a usable pin ----------------------------------------- */

    if (preferredModelId) {
      const pinned = this.#resolvePin({
        preferredModelId,
        catalog,
        requirements,
        snapshot,
        eligible,
        exclude,
      });
      if (pinned.decision) return pinned.decision;
      // An unusable pin does not fail the request; it falls through to ranking
      // and the override is reported.
      if (pinned.rejection) rejected.unshift(pinned.rejection);
      context.pinOverride = pinned.overrideReason;
    }

    /* ---- 3. Rank -------------------------------------------------------- */

    if (eligible.length === 0) {
      throw this.#nothingAvailable({ catalog, requirements, snapshot, rejected, exclude });
    }

    const ranked = [...eligible].sort(buildComparator(context));
    const [primary, ...rest] = ranked;

    return new RoutingDecision({
      primary,
      fallbacks: oneModelPerProvider(rest, [primary.provider]).slice(0, this.maxCandidates - 1),
      mode: context.pinOverride
        ? RoutingMode.OVERRIDDEN
        : requirements.isEmpty
        ? RoutingMode.AUTOMATIC
        : RoutingMode.CONSTRAINED,
      reason: context.pinOverride
        ? `${context.pinOverride}; ranked instead: ${explainWinner(primary, context)}`
        : explainWinner(primary, context),
      requirements,
      consideredCount: eligible.length,
      rejected: rejected.slice(0, MAX_REJECTIONS_RECORDED),
    });
  }

  /**
   * A user's pin wins while the model is usable.
   *
   * It is overridden only when genuinely unusable, and never silently: the user
   * has information the router does not, and a router that quietly "improves"
   * on an explicit choice produces output the user cannot reproduce
   * (docs/backend/15-decisions.md#adr-009--a-user-pinned-model-wins-over-automatic-ranking).
   *
   * The one case that is a hard error rather than an override: the pinned model
   * cannot do something the request requires. Substituting there would hand the
   * user output from a model they did not choose, for a reason they cannot see.
   */
  #resolvePin({ preferredModelId, catalog, requirements, snapshot, eligible, exclude }) {
    const model = catalog.find((m) => m.id === preferredModelId);

    if (!model) {
      return {
        rejection: new RejectionReason({
          modelId: preferredModelId,
          provider: null,
          reason: "unknown model",
        }),
        overrideReason: `"${preferredModelId}" is not a known model`,
      };
    }

    const unmet = requirements.unmetBy(model.capabilities);
    if (unmet.length) {
      const capable = eligible.map((m) => m.id).slice(0, 3);
      throw new AppError(
        `${model.displayName} cannot satisfy this request (${unmet
          .map((u) => u.capability)
          .join(", ")}).${capable.length ? ` Try: ${capable.join(", ")}.` : ""}`,
        ErrorKind.UNSUPPORTED_CAPABILITY,
        { details: { modelId: model.id, unmet, alternatives: capable } }
      );
    }

    if (exclude.includes(model.provider)) {
      return {
        rejection: new RejectionReason({
          modelId: model.id,
          provider: model.provider,
          reason: "already attempted this request",
        }),
        overrideReason: `${model.displayName} was already tried`,
      };
    }

    if (!snapshot.isAvailable(model.provider)) {
      const status = snapshot.get(model.provider).status;
      return {
        rejection: new RejectionReason({
          modelId: model.id,
          provider: model.provider,
          reason: `provider ${status}`,
        }),
        overrideReason: `${model.displayName} is unavailable (${status})`,
      };
    }

    // Usable. Fallbacks still come from the ranked pool, so a pinned request
    // degrades gracefully instead of failing outright.
    const context = new RankingContext({ catalog, requirements, snapshot });
    const fallbacks = oneModelPerProvider(
      eligible.filter((m) => m.id !== model.id).sort(buildComparator(context)),
      [model.provider]
    ).slice(0, this.maxCandidates - 1);

    return {
      decision: new RoutingDecision({
        primary: model,
        fallbacks,
        mode: RoutingMode.PINNED,
        reason: "explicitly selected by the user",
        requirements,
        consideredCount: eligible.length,
        rejected: [],
      }),
    };
  }

  /**
   * Build the error for "nothing can serve this".
   *
   * Deliberately specific. Because requirements are checked before dispatch,
   * this can name the constraint and the fix — "the largest available window is
   * 256K tokens" rather than a generic failure after a wasted round trip
   * (docs/backend/05-capability-matrix.md#errors-the-matrix-makes-possible).
   */
  #nothingAvailable({ catalog, requirements, snapshot, rejected, exclude }) {
    if (catalog.length === 0) {
      return new AppError(
        "No models are configured. Add a provider API key to get started.",
        ErrorKind.PROVIDER_UNAVAILABLE,
        { details: { reason: "empty catalog" } }
      );
    }

    // Separate the two failure shapes: nothing is *capable* versus nothing is
    // *up*. They have completely different fixes, and conflating them sends the
    // operator looking in the wrong place.
    const capable = catalog.filter(
      (m) => m.isSelectable && requirements.unmetBy(m.capabilities).length === 0
    );

    if (capable.length === 0) {
      const details = { unsatisfiable: [], requirements: requirements.toJSON() };
      for (const name of requirements.names()) {
        const best = bestOnAxis(catalog, name);
        details.unsatisfiable.push({ capability: name, bestAvailable: best });
      }
      return new AppError(
        `No available model can satisfy this request (${requirements.names().join(", ")}).`,
        ErrorKind.UNSUPPORTED_CAPABILITY,
        { details }
      );
    }

    if (exclude.length && capable.every((m) => exclude.includes(m.provider))) {
      return new AppError(
        "Every capable provider has already been tried for this request.",
        ErrorKind.PROVIDER_UNAVAILABLE,
        { details: { tried: exclude, capable: capable.map((m) => m.id) } }
      );
    }

    return new AppError(
      "All capable providers are currently unavailable. Try again shortly.",
      ErrorKind.PROVIDER_UNAVAILABLE,
      {
        details: {
          capableModels: capable.length,
          providers: [...new Set(capable.map((m) => m.provider))].map((id) => ({
            provider: id,
            status: snapshot.get(id).status,
          })),
          rejected: rejected.slice(0, MAX_REJECTIONS_RECORDED).map((r) => r.toJSON()),
        },
      }
    );
  }
}

/**
 * Keep only the best-ranked model from each provider.
 *
 * The fallback chain exists to escape a *provider-level* problem — an open
 * breaker, an exhausted quota, an outage. A second model from the same provider
 * shares that provider's breaker, credential, and quota, so trying it is not
 * failover: it is a second attempt against something already known to be
 * failing, spending an attempt from a budget of three
 * (docs/backend/04-router.md#failover-budget).
 *
 * The input is already ranked, so taking the first occurrence of each provider
 * keeps the best candidate from each.
 */
function oneModelPerProvider(models, excludeProviders = []) {
  const seen = new Set(excludeProviders);
  const out = [];
  for (const model of models) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    out.push(model);
  }
  return out;
}

function record(list, model, reason, unmet = []) {
  if (list.length >= MAX_REJECTIONS_RECORDED * 4) return; // bound the working set
  list.push(new RejectionReason({ modelId: model.id, provider: model.provider, reason, unmet }));
}

function bestOnAxis(catalog, capability) {
  let best = null;
  for (const model of catalog) {
    const value = model.capabilities.value(capability);
    if (value === true) return { modelId: model.id, value: true };
    if (Number.isFinite(value) && (best === null || value > best.value)) {
      best = { modelId: model.id, value };
    }
  }
  return best;
}

/**
 * Everything the comparators need, computed once per decision.
 *
 * Latency and fit are derived per model; doing that inside a comparator would
 * recompute them O(n log n) times and, worse, let a comparator read changing
 * state mid-sort — which produces an inconsistent ordering that Array#sort is
 * free to turn into anything at all.
 */
class RankingContext {
  constructor({ catalog, requirements, snapshot }) {
    this.snapshot = snapshot;
    this.requirements = requirements;
    this.order = new Map(catalog.map((m, index) => [m.id, index]));
    this.pinOverride = null;
    this.decidedBy = null;
  }

  healthOf(model) {
    return this.snapshot.healthOf(model.provider);
  }

  priorityOf(model) {
    return this.snapshot.priorityOf(model.provider);
  }

  /** Takes a provider id, since `byDarkness` compares by provider not model. */
  isDark(providerId) {
    return this.snapshot.isDark(providerId);
  }

  measuredLatencyFor(model) {
    return this.snapshot.latencyOf(model.provider);
  }

  /**
   * Measured latency, or an estimate from the catalog's `speed` score while a
   * provider has no samples. The estimate is deliberately pessimistic so an
   * unproven provider does not outrank a measured-fast one on a guess.
   */
  latencyFor(model) {
    const measured = this.snapshot.latencyOf(model.provider);
    if (measured !== null) return measured;
    const speed = model.capabilities.score("speed");
    return Math.round(2000 - speed * 15);
  }

  /**
   * How over-provisioned this model is for the request. Lower is better.
   *
   * Two components: unused context window, and binary capabilities the request
   * did not ask for. A vision model is typically larger, slower, and scarcer
   * than a text-only equivalent, so spending one on a text request is worse for
   * the user *and* for the next request that genuinely needs it.
   */
  fitPenalty(model) {
    const required = this.requirements.required.contextWindow ?? 0;
    const window = model.capabilities.value("contextWindow") ?? 0;
    const windowRatio = required > 0 && window > 0 ? window / required : 1;

    const requested = new Set(this.requirements.names());
    const surplus = model.capabilities
      .supported()
      .filter((name) => !requested.has(name) && SCARCE_CAPABILITIES.has(name)).length;

    return windowRatio + surplus * 2;
  }

  orderOf(model) {
    return this.order.get(model.id) ?? Number.MAX_SAFE_INTEGER;
  }

  noteDecidingCriterion(name) {
    this.decidedBy ??= name;
  }
}

/**
 * Capabilities whose models are typically scarcer or costlier. Only these count
 * toward the surplus penalty — penalising every unrequested flag would punish
 * a generally-capable model for being capable.
 */
const SCARCE_CAPABILITIES = new Set(["vision", "video", "audio", "pdf", "imageGen", "embeddings"]);
