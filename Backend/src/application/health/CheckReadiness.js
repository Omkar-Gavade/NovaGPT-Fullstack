/**
 * Readiness: should this instance receive traffic?
 *
 * Unlike liveness, this *does* check dependencies — that is the whole
 * distinction between the two, and conflating them is one of the most damaging
 * orchestration mistakes (docs/backend/09-api-design.md#operations).
 *
 * Aggregation follows the degradation matrix rather than a blanket "all
 * dependencies must be up": a failed *critical* dependency means this instance
 * cannot do its job, while a failed non-critical one means it is degraded but
 * still more useful serving than not
 * (docs/backend/13-deployment.md#degradation-matrix). Redis down must not
 * remove every instance from the load balancer.
 */
export class CheckReadiness {
  /**
   * @param {object} deps
   * @param {import("../../domain/lifecycle/ServiceState.js").ServiceState} deps.state
   * @param {import("../../domain/ports/HealthProbePort.js").HealthProbePort[]} deps.probes
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   * @param {number} [deps.probeTimeoutMs]
   */
  constructor({ state, probes, clock, metrics, probeTimeoutMs = 2000 }) {
    this.state = state;
    this.probes = probes;
    this.clock = clock;
    this.metrics = metrics;
    this.probeTimeoutMs = probeTimeoutMs;
  }

  async execute() {
    // Short-circuit while draining. Dependencies may be perfectly healthy, but
    // this instance is about to stop and must be removed from rotation first
    // — that ordering is what makes a zero-downtime deploy possible.
    if (!this.state.isAcceptingTraffic) {
      return {
        ready: false,
        phase: this.state.phase,
        reason: this.state.isShuttingDown ? "shutting down" : "starting up",
        dependencies: [],
      };
    }

    // In parallel: probes are independent, and a serial sweep would make the
    // endpoint's latency the sum of every dependency's worst case.
    const results = await Promise.all(this.probes.map((probe) => this.#runProbe(probe)));

    for (const result of results) {
      this.metrics.setGauge("nova_dependency_up", result.ok ? 1 : 0, {
        dependency: result.name,
      });
      this.metrics.observe("nova_dependency_probe_duration_seconds", result.latencyMs / 1000, {
        dependency: result.name,
      });
    }

    const blocking = results.filter((r) => r.critical && !r.ok);
    const degraded = results.filter((r) => !r.critical && !r.ok);

    return {
      ready: blocking.length === 0,
      phase: this.state.phase,
      reason:
        blocking.length > 0
          ? `${blocking.map((r) => r.name).join(", ")} unavailable`
          : degraded.length > 0
          ? `degraded: ${degraded.map((r) => r.name).join(", ")}`
          : null,
      dependencies: results.map(({ name, ok, critical, latencyMs, detail }) => ({
        name,
        ok,
        critical,
        latencyMs,
        ...(detail ? { detail } : {}),
      })),
    };
  }

  /**
   * A probe that hangs is worse than one that fails: it would hold the
   * readiness endpoint open until the orchestrator's own timeout, which reads
   * as an unresponsive instance rather than an unavailable dependency.
   */
  async #runProbe(probe) {
    const started = this.clock.now();
    try {
      return await Promise.race([
        probe.probe(),
        this.#timeout(probe, started),
      ]);
    } catch {
      return {
        name: probe.name,
        critical: probe.critical,
        ok: false,
        latencyMs: this.clock.now() - started,
        detail: "probe failed",
      };
    }
  }

  #timeout(probe, started) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          name: probe.name,
          critical: probe.critical,
          ok: false,
          latencyMs: this.clock.now() - started,
          detail: "probe timed out",
        });
      }, this.probeTimeoutMs);
      timer.unref?.();
    });
  }
}
