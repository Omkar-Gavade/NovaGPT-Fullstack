import { ProviderPhase } from "../../../domain/provider/ProviderState.js";

/**
 * Provider health, by two complementary mechanisms.
 *
 * **Passive is primary.** Every real call updates state: a success records
 * latency and closes the breaker, a failure records its kind and may open it.
 * Passive health measures the exact operation users perform, at the exact rate
 * they perform it, for free. An active probe measures a cheap endpoint that may
 * answer while completions fail — and on a free tier, every probe spends a
 * request a user could have had.
 *
 * **Active probes exist only for recovery.** The monitor probes **only
 * non-healthy** providers. Probing a healthy one is pure waste: the passive
 * signal already covers it. Probing a suspect one is what makes recovery
 * automatic — a provider whose daily quota resets at midnight returns to
 * rotation within a minute, with no human involved
 * (docs/backend/03-provider-system.md#health-system).
 *
 * ## Probe rules
 *
 * A probe may only ever **improve** state. A failed probe never opens a
 * breaker, because a flaky probe endpoint would otherwise take a working
 * provider out of rotation. Probes are also never retried: a probe is a sample,
 * and retrying distorts it.
 */
export class ProviderHealthManager {
  /**
   * @param {object} deps
   * @param {import("../registry/ProviderRegistry.js").ProviderRegistry} deps.registry
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../../domain/ports/MetricsPort.js").MetricsPort} [deps.metrics]
   * @param {number} [deps.intervalMs]
   * @param {number} [deps.probeTimeoutMs]
   */
  constructor({ registry, clock, logger, metrics, intervalMs = 60_000, probeTimeoutMs = 8000 }) {
    this.registry = registry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "provider-health" }) ?? logger;
    this.metrics = metrics;
    this.intervalMs = intervalMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.timer = null;
  }

  /* -------------------------------- passive ------------------------------ */

  recordSuccess(providerId, latencyMs) {
    this.registry.recordSuccess(providerId, latencyMs);
  }

  recordFailure(providerId, error) {
    this.registry.recordFailure(providerId, error);
  }

  /* -------------------------------- active ------------------------------- */

  /**
   * Probe one provider.
   *
   * A hanging probe is worse than a failing one: it would hold the monitor open
   * until something else gave up. The timeout is independent of, and much
   * shorter than, the completion timeout — a probe is a liveness sample, not
   * work.
   */
  async probe(providerId) {
    const provider = this.registry.get(providerId);
    if (!provider) return { ok: false, error: "not registered" };

    const started = this.clock.now();
    const state = this.registry.state(providerId);
    const wasPhase = state?.phase;
    state?.markProbing();

    let result;
    try {
      result = await Promise.race([provider.health(), this.#timeout()]);
    } catch (error) {
      result = { ok: false, latencyMs: this.clock.now() - started, error: error.message };
    }

    if (result.ok) {
      this.registry.recordSuccess(providerId, result.latencyMs ?? this.clock.now() - started);
      if (wasPhase !== ProviderPhase.HEALTHY) {
        this.logger?.info("providers.health.recovered", { provider: providerId, from: wasPhase });
      }
    } else if (state) {
      // Deliberately does not call recordFailure: a probe must never open a
      // breaker. Restore whatever phase the provider was in and let real
      // traffic decide.
      state.phase = wasPhase;
      this.logger?.debug("providers.health.probe_failed", {
        provider: providerId,
        phase: wasPhase,
        error: result.error,
      });
    }

    this.metrics?.setGauge("nova_provider_health", this.registry.health(providerId), {
      provider: providerId,
    });
    // Separate from health, and not derivable from it: a provider can be
    // perfectly healthy by success ratio and still have an open breaker after
    // a single `quota` failure. The status grid during an incident reads this
    // one (docs/backend/11-observability.md#provider-dashboard--is-the-fleet-healthy).
    // Read after `health()` above, which is what advances an expired OPEN to
    // HALF_OPEN — the phase is lazily evaluated, so the order matters.
    this.metrics?.setGauge(
      "nova_provider_breaker_state",
      breakerGauge(this.registry.state(providerId)?.phase),
      { provider: providerId }
    );

    return result;
  }

  /** Probe every registered provider. For an operator-triggered check. */
  async probeAll() {
    const results = await Promise.all(
      this.registry.ids().map(async (id) => ({
        provider: id,
        status: this.registry.statusOf(id),
        ...(await this.probe(id)),
      }))
    );
    return results;
  }

  /** The providers worth probing: configured, enabled, and not currently healthy. */
  suspects() {
    return this.registry.all().filter((provider) => {
      const state = this.registry.state(provider.id);
      if (!provider.isConfigured || !state || state.isDisabled) return false;
      return state.phase !== ProviderPhase.HEALTHY;
    });
  }

  async sweep() {
    const suspects = this.suspects();
    if (!suspects.length) return [];
    this.logger?.debug("providers.health.sweep", { count: suspects.length });
    return Promise.all(suspects.map((p) => this.probe(p.id)));
  }

  /* ------------------------------- lifecycle ----------------------------- */

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      // A sweep failing must not kill the interval — a monitor that dies on the
      // first error stops being a recovery mechanism precisely when it matters.
      this.sweep().catch((error) => this.logger?.warn("providers.health.sweep_failed", { error }));
    }, this.intervalMs);
    // Recovery polling must not hold the process open at shutdown.
    this.timer.unref?.();
    this.logger?.info("providers.health.monitor_started", { intervalMs: this.intervalMs });
    return this;
  }

  stop() {
    if (!this.timer) return this;
    clearInterval(this.timer);
    this.timer = null;
    this.logger?.info("providers.health.monitor_stopped");
    return this;
  }

  #timeout() {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, latencyMs: this.probeTimeoutMs, error: "probe timed out" }),
        this.probeTimeoutMs
      );
      timer.unref?.();
    });
  }
}

/**
 * Breaker phase as a number a dashboard can colour: 0 closed, 0.5 half-open,
 * 1 open. A string label would make the status grid a table of text rather
 * than a heat map, and would put an unbounded-ish value in a label position.
 */
function breakerGauge(phase) {
  if (phase === ProviderPhase.OPEN) return 1;
  if (phase === ProviderPhase.HALF_OPEN) return 0.5;
  return 0;
}
