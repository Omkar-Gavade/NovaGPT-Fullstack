import { RequirementSet } from "../../domain/capability/RequirementSet.js";

/**
 * Turns a request into a routing decision.
 *
 * Thin by design. It gathers the three inputs the pure policy needs — the
 * catalog, the derived requirements, and a health snapshot — calls the policy,
 * then records what happened. It contains no selection logic itself; moving any
 * here would put ranking back somewhere untestable.
 *
 * Requirements are **derived**, never accepted from the client
 * (docs/backend/05-capability-matrix.md#requirements-are-derived-not-declared).
 * A client cannot forget a requirement it did not know existed, and cannot
 * over-declare and needlessly shrink the candidate set.
 */
export class RoutingService {
  /**
   * @param {object} deps
   * @param {import("../../domain/routing/RoutingPolicy.js").RoutingPolicy} deps.policy
   * @param {import("../../infrastructure/providers/catalog/ModelRegistry.js").ModelRegistry} deps.modelRegistry
   * @param {import("../../infrastructure/routing/RegistrySnapshotSource.js").RegistrySnapshotSource} deps.snapshotSource
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   */
  constructor({ policy, modelRegistry, snapshotSource, logger, metrics, clock }) {
    this.policy = policy;
    this.modelRegistry = modelRegistry;
    this.snapshotSource = snapshotSource;
    this.logger = logger?.child?.({ component: "routing" }) ?? logger;
    this.metrics = metrics;
    this.clock = clock;
  }

  /**
   * @param {object} request
   * @param {string} [request.model]        the user's pin
   * @param {object[]} [request.attachments]
   * @param {object[]} [request.tools]
   * @param {object} [request.responseFormat]
   * @param {boolean} [request.streaming]
   * @param {number} [request.estimatedPromptTokens]
   * @param {number} [request.maxTokens]
   * @param {string[]} [request.exclude]    providers already tried
   * @returns {{decision, snapshot}}
   */
  route(request = {}) {
    const started = this.clock.now();
    const requirements = RequirementSet.from(request);
    const snapshot = this.snapshotSource.capture();
    const catalog = this.modelRegistry.all();

    try {
      const decision = this.policy.decide({
        catalog,
        requirements,
        snapshot,
        preferredModelId: request.model ?? null,
        exclude: request.exclude ?? [],
      });

      const durationMs = this.clock.now() - started;

      // The single most important log line in the system: it makes "why did my
      // request go to Groq?" answerable in one query instead of unanswerable
      // forever (docs/backend/11-observability.md#events-that-must-be-logged).
      this.logger?.info("routing.decided", { ...decision.toLog(), durationMs });

      this.metrics.increment("nova_routing_decisions_total", {
        model: decision.primary.id,
        provider: decision.primary.provider,
        mode: decision.mode,
      });
      this.metrics.observe("nova_routing_candidates", decision.consideredCount);
      this.metrics.observe("nova_routing_decision_duration_seconds", durationMs / 1000);

      return { decision, snapshot, requirements };
    } catch (error) {
      this.metrics.increment("nova_routing_exhausted_total", { reason: error.kind ?? "unknown" });
      this.metrics.observe("nova_routing_candidates", 0);
      this.logger?.warn("routing.exhausted", {
        kind: error.kind,
        message: error.message,
        requirements: requirements.toJSON(),
        catalogSize: catalog.length,
        availableProviders: snapshot.availableProviderIds,
      });
      throw error;
    }
  }

  /**
   * Re-route excluding providers already tried.
   *
   * Takes a **fresh** snapshot on purpose. Within one attempt chain the
   * snapshot is held constant for reproducibility, but an explicit re-route is
   * a new decision — and by then the fleet genuinely has changed, because the
   * failure that prompted it has just been recorded.
   */
  reroute(request, triedProviders) {
    return this.route({ ...request, exclude: [...(request.exclude ?? []), ...triedProviders] });
  }
}
