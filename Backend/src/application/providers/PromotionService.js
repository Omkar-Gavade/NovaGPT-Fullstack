import { PromotionGate } from "../../domain/provider/PromotionGate.js";

/**
 * Answers "is this dark provider ready for normal ranking?" from what actually
 * happened, rather than from what someone remembers happening.
 *
 * The telemetry comes from **usage records**, not from metrics. Metrics are
 * aggregated and rolled up — by the time 48 hours have passed, the per-attempt
 * detail needed to compute an error rate for one provider over one window has
 * been averaged away. Usage records keep one row per attempt with its outcome,
 * which is exactly the shape this question needs
 * ([11](../../../docs/backend/11-observability.md#cost-monitoring)).
 */
export class PromotionService {
  constructor({ usage, registry, clock, logger, gate = new PromotionGate(), darkSince = {} }) {
    this.usage = usage;
    this.registry = registry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "promotion" }) ?? logger;
    this.gate = gate;
    // When each dark provider entered observation. Configured rather than
    // inferred: inferring it from the first usage record would restart the
    // clock every time a provider went a whole window without traffic.
    this.darkSince = darkSince;
  }

  /** @param {string[]} darkProviders currently ranked last */
  async report(darkProviders) {
    const now = this.clock.now();
    const rows = [];

    for (const provider of darkProviders) {
      const records = await this.usage.list({ provider, limit: 5000 });
      const attempts = records.length;
      const failures = records.filter((r) => r.outcome === "failure").length;

      const latencies = records
        .map((r) => r.latencyMs)
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => a - b);
      const p95 = latencies.length
        ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : null;

      const since = this.darkSince[provider] ? new Date(this.darkSince[provider]).getTime() : now;

      const verdict = this.gate.evaluate({
        provider,
        observedMs: Math.max(0, now - since),
        attempts,
        failures,
        p95LatencyMs: p95,
        // A breaker that is open *now*, or a provider that is not available,
        // means it took itself out of rotation during observation.
        breakerOpened: !this.registry.isAvailable(provider),
      });

      rows.push({ provider, ...verdict, attempts, failures, p95LatencyMs: p95 });
    }

    return rows;
  }
}
