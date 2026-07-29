/**
 * The process lifecycle as an explicit state machine.
 *
 * Pure domain: no I/O, no timers, no signals. The shutdown handler
 * (infrastructure) drives it and the readiness check (application) reads it,
 * and because both may import the domain but not each other, this is the only
 * placement that keeps the dependency rule intact
 * (docs/backend/02-architecture.md#dependency-flow).
 *
 * The transitions are one-way on purpose. A process that has begun draining
 * must never advertise itself as ready again — a load balancer that re-adds a
 * draining instance sends traffic to a socket that is about to close.
 */

export const Phase = {
  STARTING: "starting",
  READY: "ready",
  DRAINING: "draining",
  STOPPED: "stopped",
};

const ALLOWED = {
  [Phase.STARTING]: [Phase.READY, Phase.DRAINING, Phase.STOPPED],
  [Phase.READY]: [Phase.DRAINING, Phase.STOPPED],
  [Phase.DRAINING]: [Phase.STOPPED],
  [Phase.STOPPED]: [],
};

export class ServiceState {
  constructor(startedAtMs) {
    this.phase = Phase.STARTING;
    this.startedAtMs = startedAtMs;
  }

  /**
   * @returns {boolean} whether the transition was applied. Invalid transitions
   * are ignored rather than thrown: shutdown can be triggered twice (SIGTERM
   * then SIGINT), and the second must not raise inside a signal handler.
   */
  transitionTo(phase) {
    if (!ALLOWED[this.phase].includes(phase)) return false;
    this.phase = phase;
    return true;
  }

  markReady() {
    return this.transitionTo(Phase.READY);
  }

  markDraining() {
    return this.transitionTo(Phase.DRAINING);
  }

  markStopped() {
    return this.transitionTo(Phase.STOPPED);
  }

  /** Liveness: the process should be restarted only if this is false. */
  get isAlive() {
    return this.phase !== Phase.STOPPED;
  }

  /** Readiness gate: false while starting or draining, regardless of dependencies. */
  get isAcceptingTraffic() {
    return this.phase === Phase.READY;
  }

  get isShuttingDown() {
    return this.phase === Phase.DRAINING || this.phase === Phase.STOPPED;
  }

  uptimeMs(nowMs) {
    return nowMs - this.startedAtMs;
  }
}
