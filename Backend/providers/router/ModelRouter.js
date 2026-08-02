import { registry } from "../registry/index.js";
import { CATALOG, findModel } from "../registry/catalog.js";
import { ProviderError, FailureKind } from "../interfaces/Provider.js";

/**
 * Smart Model Router.
 *
 * Picks a model, executes through its provider adapter, and — when a provider
 * fails for an operational reason — transparently retries on the best
 * compatible alternative. The caller is always told when a switch happened so
 * the UI can surface it; failover is never silent.
 *
 * Candidate ranking (in order):
 *   1. user preference (explicitly chosen model wins outright)
 *   2. required capabilities (vision / tools / context window)
 *   3. availability (configured + not in cooldown)
 *   4. free quota (free tier preferred when capability-equal)
 *   5. latency (measured rolling average, falls back to catalog speed)
 *   6. cost
 */

const COST_RANK = { Free: 0, "—": 0, $: 1, $$: 2, $$$: 3 };

export const SwitchPolicy = {
  AUTO: "auto",
  ASK: "ask",
  NEVER: "never",
};

/** Models that can serve this request at all. */
function capableModels({ requiresVision, requiresTools, minContext } = {}) {
  return CATALOG.filter((m) => {
    if (requiresVision && !m.vision) return false;
    if (requiresTools && !m.tools) return false;
    if (minContext && m.context < minContext) return false;
    return true;
  });
}

/** Rank candidates: health -> availability -> free tier -> latency -> cost. */
export function rankCandidates(requirements = {}, excludeProviders = []) {
  return capableModels(requirements)
    .filter((m) => !excludeProviders.includes(m.provider))
    .filter((m) => registry.isAvailable(m.provider))
    .map((m) => {
      const measured = registry.averageLatency(m.provider);
      return {
        model: m,
        // lower is better
        healthRank: 1 - registry.health(m.provider), // 0 = fully healthy
        freeRank: m.tier === "free" ? 0 : 1,
        latencyRank: measured ?? Math.round(1000 - m.speed * 8),
        costRank: COST_RANK[m.cost] ?? 2,
      };
    })
    .sort(
      (a, b) =>
        a.healthRank - b.healthRank ||
        a.freeRank - b.freeRank ||
        a.latencyRank - b.latencyRank ||
        a.costRank - b.costRank
    )
    .map((c) => c.model);
}

/**
 * Resolve the model to start with.
 * A user-chosen model always wins, even if it looks slower or pricier — the
 * router only overrides it when it is genuinely unusable.
 */
export function resolveModel(preferredModelId, requirements = {}) {
  if (preferredModelId) {
    const model = findModel(preferredModelId);
    if (model && registry.isAvailable(model.provider)) return model;
  }
  return rankCandidates(requirements)[0] ?? null;
}

/**
 * Execute a capability against the routed provider, with failover.
 *
 * @param {"generate"|"stream"|"vision"|"embeddings"|"toolCalling"} capability
 * @param {object} opts
 * @param {string} opts.modelId          user-selected model (preference)
 * @param {object} opts.requirements     { requiresVision, requiresTools, minContext }
 * @param {string} opts.switchPolicy     auto | ask | never
 * @param {function} opts.invoke         (provider, model) => result
 * @param {AbortSignal} [opts.signal]     caller cancellation (client disconnect)
 * @returns {{ result, model, switched: null | { from, to, reason, message } }}
 */
export async function route(capability, { modelId, requirements = {}, switchPolicy = SwitchPolicy.AUTO, invoke, signal }) {
  const primary = resolveModel(modelId, requirements);
  if (!primary) {
    throw new ProviderError(
      "No provider is configured. Add an API key to get started.",
      FailureKind.AUTH
    );
  }

  const tried = [];
  let current = primary;
  let switched = null;

  // one primary attempt + up to two failover attempts
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) throw new ProviderError("Request cancelled", FailureKind.TIMEOUT);
    const provider = registry.get(current.provider);
    const started = Date.now();

    try {
      const result = await invoke(provider, current);
      registry.recordSuccess(current.provider, Date.now() - started);
      return { result, model: current, switched };
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) throw err; // don't fail over a cancel
      const error = err instanceof ProviderError ? err : new ProviderError(err.message, FailureKind.API_ERROR);
      registry.recordFailure(current.provider, error);
      tried.push(current.provider);

      const canFailover =
        error.isFailoverWorthy && switchPolicy !== SwitchPolicy.NEVER && attempt < 2;

      if (!canFailover) {
        error.model = current;
        error.capability = capability;
        throw error;
      }

      const next = rankCandidates(requirements, tried)[0];
      if (!next) {
        error.model = current;
        throw error;
      }

      // "ask" surfaces the proposal instead of switching for the user
      if (switchPolicy === SwitchPolicy.ASK) {
        const proposal = new ProviderError(error.message, error.kind, { provider: current.provider });
        proposal.requiresConfirmation = true;
        proposal.model = current;
        proposal.suggestion = next;
        throw proposal;
      }

      switched = {
        from: current,
        to: next,
        reason: error.kind,
        message: `${current.name} ${reasonPhrase(error.kind)}. Switched to ${next.name}.`,
      };
      current = next;
    }
  }

  throw new ProviderError("All compatible providers failed", FailureKind.OUTAGE);
}

function reasonPhrase(kind) {
  return (
    {
      [FailureKind.QUOTA]: "quota reached",
      [FailureKind.RATE_LIMIT]: "hit its rate limit",
      [FailureKind.TIMEOUT]: "timed out",
      [FailureKind.OUTAGE]: "is unavailable",
      [FailureKind.API_ERROR]: "returned an error",
    }[kind] || "failed"
  );
}
