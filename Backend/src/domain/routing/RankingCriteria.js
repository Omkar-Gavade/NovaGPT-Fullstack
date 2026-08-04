import { CostBand } from "../capability/Capability.js";

/**
 * The ranking criteria, as independent comparators.
 *
 * Selection is a **lexicographic sort**: compare on the first criterion, break
 * ties with the second, and so on
 * (docs/backend/04-router.md#ranking). Written as separate named functions
 * rather than one composite score for two reasons:
 *
 *   - **Each is testable in isolation.** "Does health outrank latency?" is a
 *     two-line test. With a weighted score it would be an exercise in choosing
 *     inputs that isolate one weight.
 *   - **Lexicographic beats weighted.** A weighted sum needs weights nobody can
 *     justify, and it silently lets three small advantages outvote a large
 *     one — a fast, cheap, free provider outranking a *healthy* one is exactly
 *     the trade the ordering exists to forbid.
 *
 * Every comparator returns the standard negative/zero/positive, and **lower
 * sorts first**, so each converts its notion of "better" into "smaller".
 */

const COST_RANK = Object.fromEntries(CostBand.map((band, index) => [band, index]));

/**
 * Health is quantised before comparison.
 *
 * Without this, a 0.98 provider outranks a 0.97 one and the ordering churns on
 * statistical noise — one unlucky sample reshuffles routing. Buckets of 0.1
 * keep genuinely different health levels apart while treating
 * indistinguishable ones as tied, letting the cheaper/faster criteria decide.
 */
const HEALTH_BUCKET = 0.1;
const bucketHealth = (health) => Math.round(health / HEALTH_BUCKET);

/**
 * 0 — Dark providers rank below every promoted one.
 *
 * A provider ships **dark** after its adapter passes the contract suite but
 * before it has earned user traffic: configured, reachable, and ranked last, so
 * it receives requests only as a late failover
 * (docs/backend/03-provider-system.md#provider-onboarding-process). It
 * accumulates real telemetry against real traffic with a bounded blast radius.
 *
 * **Above health, and that ordering is the point.** A dark provider in perfect
 * health must still rank below a promoted one that is struggling, because the
 * question dark answers is not "does this work?" but "have we watched it work
 * long enough to hand it a user's request?". Placing this below health would
 * let a brand-new provider outrank the fleet the moment anything else dipped —
 * which is precisely the blast radius shipping dark exists to bound.
 *
 * It is a *ranking* criterion rather than a filter, so a dark provider is still
 * reachable when everything promoted has failed. Being last is not being
 * excluded, and a fleet that would otherwise have no candidate left should use
 * what it has.
 */
export function byDarkness(a, b, context) {
  return (context.isDark(a.provider) ? 1 : 0) - (context.isDark(b.provider) ? 1 : 0);
}

/** 1 — Health, descending. A likely failure costs an attempt *plus* a failover. */
export function byHealth(a, b, context) {
  return bucketHealth(context.healthOf(b)) - bucketHealth(context.healthOf(a));
}

/**
 * 2 — Operator priority, descending.
 *
 * Placed after health, never before: priority is a *bias*, and an operator
 * preference must not send traffic to a provider that is failing
 * (docs/backend/04-router.md#provider-prioritisation). Placed above tier and
 * latency because an explicit operator instruction outranks the system's own
 * automatic preferences — the same principle as a user's model pin
 * (ADR-009), with health as the safety carve-out.
 */
export function byPriority(a, b, context) {
  return context.priorityOf(b) - context.priorityOf(a);
}

/** 3 — Free tier before paid. A preference, not a mandate — hence below health. */
export function byTier(a, b) {
  return (a.isFree ? 0 : 1) - (b.isFree ? 0 : 1);
}

/**
 * 4 — Latency, ascending, measured where possible.
 *
 * Falls back to the catalog's `speed` score only while a provider has no real
 * samples. Static scores are gathered under ideal conditions; measured latency
 * reflects this deployment's region, network, and the provider's current load.
 */
export function byLatency(a, b, context) {
  return context.latencyFor(a) - context.latencyFor(b);
}

/** 5 — Cost band, ascending. Coarse on purpose: exact per-token pricing rots. */
export function byCost(a, b) {
  return (COST_RANK[a.costBand] ?? 99) - (COST_RANK[b.costBand] ?? 99);
}

/**
 * 6 — Capability fit: prefer the least over-provisioned model.
 *
 * Routing a 200-token question to a 2M-context model spends a scarce resource
 * on a request that does not need it, and starves the long-document request
 * that arrives a minute later.
 */
export function byCapabilityFit(a, b, context) {
  return context.fitPenalty(a) - context.fitPenalty(b);
}

/**
 * 7 — Stable tiebreak on catalog order.
 *
 * Explicit because an unstable sort makes identical requests route differently
 * across restarts, which makes bug reports irreproducible. Determinism is worth
 * more than any marginal gain from randomising.
 */
export function byCatalogOrder(a, b, context) {
  return context.orderOf(a) - context.orderOf(b);
}

/** The chain, in the order the documentation defines. */
export const RANKING_CHAIN = Object.freeze([
  { name: "darkness", compare: byDarkness },
  { name: "health", compare: byHealth },
  { name: "priority", compare: byPriority },
  { name: "tier", compare: byTier },
  { name: "latency", compare: byLatency },
  { name: "cost", compare: byCost },
  { name: "capabilityFit", compare: byCapabilityFit },
  { name: "catalogOrder", compare: byCatalogOrder },
]);

/**
 * Apply the chain, and report which criterion actually decided.
 *
 * The deciding criterion is what makes a routing decision explainable — "chosen
 * on latency" is a diagnosis, "chosen" is not.
 *
 * @returns {{ compare: (a, b) => number, decidedBy: Map<string, string> }}
 */
export function buildComparator(context, chain = RANKING_CHAIN) {
  return (a, b) => {
    for (const criterion of chain) {
      const result = criterion.compare(a, b, context);
      if (result !== 0) {
        context.noteDecidingCriterion?.(criterion.name);
        return result;
      }
    }
    return 0;
  };
}

/** Why the winner won, for the decision's `reason` string. */
export function explainWinner(model, context) {
  const parts = [];
  const health = context.healthOf(model);
  if (health >= 1) parts.push("healthy");
  else if (health > 0) parts.push(`health ${health.toFixed(2)}`);

  const priority = context.priorityOf(model);
  if (priority !== 0) parts.push(`operator priority ${priority > 0 ? "+" : ""}${priority}`);

  parts.push(model.isFree ? "free tier" : "paid tier");

  const latency = context.measuredLatencyFor(model);
  parts.push(latency === null ? "no latency history" : `${latency}ms measured`);

  return parts.join(", ");
}
