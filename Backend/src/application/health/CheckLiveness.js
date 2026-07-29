/**
 * Liveness: should this process be restarted?
 *
 * MUST NOT check any dependency. This is the rule that most often gets broken
 * and it is expensive when it does: if liveness probed Mongo, a database blip
 * would fail the probe on every instance simultaneously, the orchestrator would
 * restart all of them, and a degraded dependency would become a full outage
 * (docs/backend/09-api-design.md#operations).
 *
 * The only thing that makes this process worth restarting is the process being
 * broken, and a process able to answer at all is answering that question.
 */
export class CheckLiveness {
  /**
   * @param {object} deps
   * @param {import("../../domain/lifecycle/ServiceState.js").ServiceState} deps.state
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   */
  constructor({ state, clock }) {
    this.state = state;
    this.clock = clock;
  }

  execute() {
    return {
      alive: this.state.isAlive,
      phase: this.state.phase,
      uptimeMs: this.state.uptimeMs(this.clock.now()),
    };
  }
}
