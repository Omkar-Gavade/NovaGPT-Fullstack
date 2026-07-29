import { FailureKind, COOLDOWN_MS } from "../errors/ProviderError.js";

/**
 * The provider lifecycle, as an explicit state machine.
 *
 * Pure domain — no timers, no I/O, no clock of its own. Time arrives as an
 * argument, which is what lets a 15-minute quota cooldown be asserted in a
 * microsecond (docs/backend/03-provider-system.md#provider-lifecycle).
 *
 * This is deliberately one object rather than two. A circuit breaker and a
 * lifecycle are usually modelled separately, but here they share a single
 * question — *may the router send this provider a request right now?* — and
 * splitting them produces two sources of truth that drift: a provider can end
 * up `Draining` and `Closed` at once, and the answer depends on which object
 * you ask.
 */

export const ProviderPhase = {
  /** Constructed but never probed. */
  REGISTERED: "registered",
  /** No credentials. Never selected; not an error. */
  UNCONFIGURED: "unconfigured",
  /** Startup or recovery probe in flight. */
  PROBING: "probing",
  /** Fully eligible. */
  HEALTHY: "healthy",
  /** Eligible but deprioritised — recent failures, below threshold. */
  DEGRADED: "degraded",
  /** Rejected without a network call until the cooldown elapses. */
  OPEN: "open",
  /** Cooldown elapsed; one probe request allowed through. */
  HALF_OPEN: "half_open",
  /** Operator disabled it. No new requests; in-flight work finishes. */
  DRAINING: "draining",
  /** Removed from the registry. */
  STOPPED: "stopped",
};

/** Statuses the outside world sees. Internal phases are never exposed directly. */
export const ProviderStatus = {
  READY: "ready",
  OFFLINE: "offline",
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota_reached",
  UNCONFIGURED: "unconfigured",
  DISABLED: "disabled",
};

const LATENCY_SAMPLE_SIZE = 20;

export class ProviderState {
  /**
   * @param {object} [options]
   * @param {string} [options.providerId]
   * @param {boolean} [options.configured]
   * @param {number} [options.failureThreshold] consecutive transient failures
   *        before the breaker opens
   */
  constructor({ providerId, configured = true, failureThreshold = 3 } = {}) {
    this.providerId = providerId;
    this.failureThreshold = failureThreshold;
    this.phase = configured ? ProviderPhase.REGISTERED : ProviderPhase.UNCONFIGURED;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastFailureKind = null;
    this.lastError = null;
    this.lastCheckedAt = null;
    this.calls = 0;
    this.failures = 0;
    this.latencySamples = [];
  }

  /* ------------------------------ transitions ---------------------------- */

  markConfigured(configured) {
    if (!configured) {
      this.phase = ProviderPhase.UNCONFIGURED;
    } else if (this.phase === ProviderPhase.UNCONFIGURED) {
      // Credentials added at runtime bring a provider back into play without
      // a restart.
      this.phase = ProviderPhase.REGISTERED;
    }
    return this;
  }

  markProbing() {
    if (this.phase === ProviderPhase.UNCONFIGURED || this.isDisabled) return false;
    this.phase = ProviderPhase.PROBING;
    return true;
  }

  /**
   * A successful call or probe.
   *
   * Any success closes the breaker completely. A half-open probe succeeding is
   * the recovery signal, and requiring several consecutive successes would keep
   * a recovered provider sidelined while its competitors absorb the traffic.
   */
  recordSuccess(latencyMs, nowMs) {
    if (this.isDisabled) return this;
    this.phase = ProviderPhase.HEALTHY;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastFailureKind = null;
    this.lastError = null;
    this.calls += 1;
    this.lastCheckedAt = nowMs;
    if (Number.isFinite(latencyMs)) {
      this.latencySamples = [...this.latencySamples, latencyMs].slice(-LATENCY_SAMPLE_SIZE);
    }
    return this;
  }

  /**
   * A failed call.
   *
   * Threshold asymmetry is the point (docs/backend/04-router.md#circuit-breaker).
   * `quota` and `auth` open the breaker on the *first* failure: they are facts
   * about provider state, so a second attempt is guaranteed waste. Transient
   * kinds need three consecutive failures, because one timeout is a sample, not
   * a diagnosis.
   *
   * Consecutive, not windowed: a provider failing 1-in-10 is degraded but
   * usable and should be deprioritised, not removed. A windowed rate would
   * conflate that with a provider failing three in a row, which is unusable.
   */
  recordFailure(kind = FailureKind.API_ERROR, nowMs, error = null) {
    if (this.isDisabled) return this;
    this.consecutiveFailures += 1;
    this.failures += 1;
    this.lastFailureKind = kind;
    this.lastError = error ? { kind, message: error.message } : { kind };
    this.lastCheckedAt = nowMs;

    const opensNow =
      kind === FailureKind.QUOTA ||
      kind === FailureKind.AUTH ||
      // A failed half-open probe *is* a failed request; reopen immediately.
      this.phase === ProviderPhase.HALF_OPEN ||
      this.consecutiveFailures >= this.failureThreshold;

    if (opensNow) {
      this.phase = ProviderPhase.OPEN;
      this.openUntil = nowMs + (COOLDOWN_MS[kind] ?? 30_000);
    } else {
      this.phase = ProviderPhase.DEGRADED;
    }
    return this;
  }

  /** Operator disable. In-flight work finishes; nothing new is admitted. */
  drain() {
    if (this.phase === ProviderPhase.UNCONFIGURED) return false;
    this.phase = ProviderPhase.DRAINING;
    return true;
  }

  /** Operator re-enable. Returns to an unproven state, not to healthy. */
  resume() {
    if (this.phase !== ProviderPhase.DRAINING) return false;
    this.phase = ProviderPhase.REGISTERED;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    return true;
  }

  stop() {
    this.phase = ProviderPhase.STOPPED;
    return this;
  }

  /* -------------------------------- queries ------------------------------ */

  get isDisabled() {
    return this.phase === ProviderPhase.DRAINING || this.phase === ProviderPhase.STOPPED;
  }

  /**
   * May the router send a request right now?
   *
   * Reading the clock here is what promotes `open` to `half_open` lazily —
   * no timer has to fire for a provider to become eligible again, which means
   * recovery does not depend on a background loop still running.
   */
  allowsRequest(nowMs) {
    if (this.phase === ProviderPhase.OPEN && nowMs >= this.openUntil) {
      this.phase = ProviderPhase.HALF_OPEN;
    }
    return ![
      ProviderPhase.OPEN,
      ProviderPhase.UNCONFIGURED,
      ProviderPhase.DRAINING,
      ProviderPhase.STOPPED,
    ].includes(this.phase);
  }

  /**
   * 0..1 ranking input.
   *
   * Continuous rather than boolean so traffic shifts away *gradually* as a
   * provider degrades. Without a middle value the breaker is a cliff — a
   * provider is perfect until it is dead — and every failure lands on a user.
   */
  health(nowMs) {
    if (this.phase === ProviderPhase.OPEN && nowMs >= this.openUntil) {
      this.phase = ProviderPhase.HALF_OPEN;
    }
    switch (this.phase) {
      case ProviderPhase.HEALTHY:
        return 1;
      case ProviderPhase.REGISTERED:
      case ProviderPhase.PROBING:
        // Unproven, not unhealthy. Ranked below a provider with a success
        // record but well above one that is failing.
        return 0.75;
      case ProviderPhase.DEGRADED:
        // Decays with each consecutive failure, bottoming out just above open.
        return Math.max(0.25, 1 - this.consecutiveFailures / this.failureThreshold);
      case ProviderPhase.HALF_OPEN:
        return 0.5;
      default:
        return 0;
    }
  }

  averageLatencyMs() {
    if (!this.latencySamples.length) return null;
    const total = this.latencySamples.reduce((a, b) => a + b, 0);
    return Math.round(total / this.latencySamples.length);
  }

  cooldownRemainingMs(nowMs) {
    return this.phase === ProviderPhase.OPEN ? Math.max(0, this.openUntil - nowMs) : 0;
  }

  /**
   * Project the internal phase onto the small status set the API exposes.
   *
   * Projecting rather than exposing the phase keeps the state machine free to
   * gain a phase later without that being a breaking API change
   * (docs/backend/03-provider-system.md#the-status-projection).
   */
  status(nowMs) {
    if (this.phase === ProviderPhase.UNCONFIGURED) return ProviderStatus.UNCONFIGURED;
    if (this.isDisabled) return ProviderStatus.DISABLED;
    if (this.phase === ProviderPhase.OPEN && nowMs < this.openUntil) {
      if (this.lastFailureKind === FailureKind.QUOTA) return ProviderStatus.QUOTA;
      if (this.lastFailureKind === FailureKind.RATE_LIMIT) return ProviderStatus.RATE_LIMITED;
      return ProviderStatus.OFFLINE;
    }
    return ProviderStatus.READY;
  }

  snapshot(nowMs) {
    return {
      providerId: this.providerId,
      phase: this.phase,
      status: this.status(nowMs),
      health: this.health(nowMs),
      available: this.allowsRequest(nowMs),
      cooldownRemainingMs: this.cooldownRemainingMs(nowMs),
      latencyMs: this.averageLatencyMs(),
      calls: this.calls,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
    };
  }
}
