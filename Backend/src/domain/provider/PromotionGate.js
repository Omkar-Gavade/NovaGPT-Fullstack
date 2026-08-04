/**
 * Whether a dark provider has earned normal ranking.
 *
 * Step 10 of onboarding: *"after 48 hours with acceptable error rate and
 * latency, it enters normal ranking. A provider that fails this gate stays dark
 * or is removed — 'it mostly works' is not a passing grade for something the
 * router will hand user traffic to"*
 * ([03](../../../docs/backend/03-provider-system.md#provider-onboarding-process)).
 *
 * Pure: it takes measured telemetry and returns a verdict with reasons. No
 * clock, no metrics client, no storage — so every threshold is a unit test
 * rather than something an operator discovers by promoting a provider that
 * should not have been.
 *
 * **It returns a recommendation, not an action.** Promotion stays an operator
 * decision, because the gate can only see what it was given: it cannot know
 * that the clean 48 hours happened to fall over a weekend, or that the provider
 * changed its terms yesterday. Automating the promotion would take the one
 * judgement worth keeping and hide it behind a threshold.
 */

export const PromotionVerdict = {
  READY: "ready",
  NOT_YET: "not_yet",
  FAILING: "failing",
};

export class PromotionGate {
  /**
   * @param {object} [options]
   * @param {number} [options.minObservationMs] how long it must have been dark
   * @param {number} [options.minAttempts] below this, the sample proves nothing
   * @param {number} [options.maxErrorRate] 0..1
   * @param {number} [options.maxP95LatencyMs]
   */
  constructor({
    minObservationMs = 48 * 60 * 60 * 1000,
    minAttempts = 100,
    maxErrorRate = 0.02,
    maxP95LatencyMs = 20_000,
  } = {}) {
    this.minObservationMs = minObservationMs;
    this.minAttempts = minAttempts;
    this.maxErrorRate = maxErrorRate;
    this.maxP95LatencyMs = maxP95LatencyMs;
  }

  /**
   * @param {object} telemetry
   * @param {string} telemetry.provider
   * @param {number} telemetry.observedMs  how long it has been dark
   * @param {number} telemetry.attempts
   * @param {number} telemetry.failures
   * @param {number|null} telemetry.p95LatencyMs
   * @param {boolean} [telemetry.breakerOpened] did it ever open in the window?
   * @returns {{verdict: string, ready: boolean, reasons: string[]}}
   */
  evaluate(telemetry) {
    const reasons = [];
    const errorRate = telemetry.attempts > 0 ? telemetry.failures / telemetry.attempts : 0;

    // Blocking failures first: these mean *stay dark or remove*, not *wait*.
    if (telemetry.attempts >= this.minAttempts && errorRate > this.maxErrorRate) {
      reasons.push(
        `error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(this.maxErrorRate * 100).toFixed(1)}%`
      );
    }
    if (telemetry.p95LatencyMs !== null && telemetry.p95LatencyMs > this.maxP95LatencyMs) {
      reasons.push(`p95 latency ${telemetry.p95LatencyMs}ms exceeds ${this.maxP95LatencyMs}ms`);
    }
    // Any breaker opening at all is disqualifying during observation. A
    // provider that took itself out of rotation once while carrying only
    // failover traffic will do it far more often carrying primary traffic.
    if (telemetry.breakerOpened) {
      reasons.push("the breaker opened during the observation window");
    }

    if (reasons.length > 0) {
      return { verdict: PromotionVerdict.FAILING, ready: false, reasons };
    }

    // Then the "not enough evidence yet" conditions, which are a different
    // answer: keep waiting rather than give up.
    const waiting = [];
    if (telemetry.observedMs < this.minObservationMs) {
      const remaining = Math.ceil((this.minObservationMs - telemetry.observedMs) / 3_600_000);
      waiting.push(`${remaining}h of observation remaining`);
    }
    // A provider with four clean attempts has not demonstrated anything. This
    // is the check that stops a quiet weekend reading as a passing grade.
    if (telemetry.attempts < this.minAttempts) {
      waiting.push(`${telemetry.attempts} of ${this.minAttempts} attempts observed`);
    }

    if (waiting.length > 0) {
      return { verdict: PromotionVerdict.NOT_YET, ready: false, reasons: waiting };
    }

    return {
      verdict: PromotionVerdict.READY,
      ready: true,
      reasons: [
        `${telemetry.attempts} attempts, ${(errorRate * 100).toFixed(2)}% errors, ` +
          `p95 ${telemetry.p95LatencyMs ?? "n/a"}ms over ${Math.floor(telemetry.observedMs / 3_600_000)}h`,
      ],
    };
  }
}
