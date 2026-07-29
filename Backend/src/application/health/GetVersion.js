/**
 * Build and runtime identity.
 *
 * Answers "what is actually deployed here?" — which is unanswerable from a
 * mutable image tag, and is the first question asked when production behaves
 * differently from staging (docs/backend/13-deployment.md#pipeline-decisions).
 *
 * Deliberately narrow. It reports what was built, never what it is configured
 * with: dependency URLs, feature flags, and provider inventory are operational
 * detail that tells an attacker what to target.
 */
export class GetVersion {
  /**
   * @param {object} deps
   * @param {import("../../infrastructure/config/loadConfig.js").Config["service"]} deps.service
   * @param {import("../../domain/lifecycle/ServiceState.js").ServiceState} deps.state
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {string} deps.environment
   * @param {string} deps.runtime  injected rather than read from `process`, so
   *                               this use case stays free of ambient globals
   */
  constructor({ service, state, clock, environment, runtime }) {
    this.service = service;
    this.state = state;
    this.clock = clock;
    this.environment = environment;
    this.runtime = runtime;
  }

  execute() {
    return {
      name: this.service.name,
      version: this.service.version,
      commit: this.service.commit,
      builtAt: this.service.builtAt,
      environment: this.environment,
      runtime: this.runtime,
      startedAt: new Date(this.state.startedAtMs).toISOString(),
      uptimeMs: this.state.uptimeMs(this.clock.now()),
    };
  }
}
