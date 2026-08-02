import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderState,
  ProviderPhase,
  ProviderStatus,
} from "../../src/domain/provider/ProviderState.js";
import { FailureKind } from "../../src/domain/errors/ProviderError.js";

const build = (options) => new ProviderState({ providerId: "test", ...options });

describe("ProviderState — initial", () => {
  test("starts registered when configured, unconfigured otherwise", () => {
    assert.equal(build().phase, ProviderPhase.REGISTERED);
    assert.equal(build({ configured: false }).phase, ProviderPhase.UNCONFIGURED);
  });

  test("an unconfigured provider is never selectable and scores zero", () => {
    const state = build({ configured: false });
    assert.equal(state.allowsRequest(0), false);
    assert.equal(state.health(0), 0);
    assert.equal(state.status(0), ProviderStatus.UNCONFIGURED);
  });

  test("an unproven provider ranks below a proven one but above a failing one", () => {
    // Registered is "not yet tested", not "unhealthy". Treating the two the
    // same would leave a fresh provider permanently last.
    assert.equal(build().health(0), 0.75);
  });

  test("credentials added at runtime bring it back into play", () => {
    const state = build({ configured: false });
    state.markConfigured(true);
    assert.equal(state.phase, ProviderPhase.REGISTERED);
    assert.ok(state.allowsRequest(0));
  });
});

describe("ProviderState — success and failure", () => {
  test("a success makes it healthy and records latency", () => {
    const state = build();
    state.recordSuccess(120, 1000);
    assert.equal(state.phase, ProviderPhase.HEALTHY);
    assert.equal(state.health(1000), 1);
    assert.equal(state.averageLatencyMs(), 120);
  });

  test("latency is a rolling average over the last 20 samples", () => {
    const state = build();
    for (let i = 1; i <= 25; i += 1) state.recordSuccess(i * 10, i);
    // Samples 6..25 => 60..250, mean 155.
    assert.equal(state.averageLatencyMs(), 155);
  });

  test("one transient failure degrades but does not open", () => {
    const state = build();
    state.recordFailure(FailureKind.TIMEOUT, 1000);
    assert.equal(state.phase, ProviderPhase.DEGRADED);
    assert.ok(state.allowsRequest(1000), "a degraded provider is still usable");
    assert.ok(state.health(1000) < 1 && state.health(1000) > 0);
  });

  test("health decays with each consecutive failure", () => {
    const state = build();
    state.recordFailure(FailureKind.TIMEOUT, 0);
    const afterOne = state.health(0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    // Gradual, not a cliff: traffic shifts away as a provider degrades rather
    // than all at once when it dies.
    assert.ok(state.health(0) < afterOne);
  });

  test("three consecutive transient failures open the breaker", () => {
    const state = build();
    for (let i = 0; i < 3; i += 1) state.recordFailure(FailureKind.TIMEOUT, 1000);
    assert.equal(state.phase, ProviderPhase.OPEN);
    assert.equal(state.allowsRequest(1000), false);
    assert.equal(state.health(1000), 0);
  });

  test("quota opens the breaker on the first failure", () => {
    // A quota error is a fact about provider state; a second attempt is
    // guaranteed waste.
    const state = build();
    state.recordFailure(FailureKind.QUOTA, 1000);
    assert.equal(state.phase, ProviderPhase.OPEN);
  });

  test("auth opens the breaker on the first failure", () => {
    const state = build();
    state.recordFailure(FailureKind.AUTH, 1000);
    assert.equal(state.phase, ProviderPhase.OPEN);
  });

  test("a success resets the consecutive counter", () => {
    const state = build();
    state.recordFailure(FailureKind.TIMEOUT, 0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    state.recordSuccess(10, 0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    // Consecutive, not windowed: 1-in-10 failures is degraded-but-usable,
    // three in a row is unusable, and a rate would conflate them.
    assert.equal(state.phase, ProviderPhase.DEGRADED);
  });

  test("counts calls and failures separately", () => {
    const state = build();
    state.recordSuccess(10, 0);
    state.recordSuccess(10, 0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    assert.equal(state.calls, 2);
    assert.equal(state.failures, 1);
  });
});

describe("ProviderState — cooldown and recovery", () => {
  test("cooldown length matches the failure cause", () => {
    const quota = build();
    quota.recordFailure(FailureKind.QUOTA, 0);
    assert.equal(quota.cooldownRemainingMs(0), 15 * 60_000);

    // rate_limit is transient, so it only opens once the threshold is crossed.
    const limited = build();
    for (let i = 0; i < 3; i += 1) limited.recordFailure(FailureKind.RATE_LIMIT, 0);
    assert.equal(limited.cooldownRemainingMs(0), 60_000);
  });

  test("becomes half-open once the cooldown elapses, with no timer", () => {
    // Reading the clock lazily means recovery does not depend on a background
    // loop still running.
    const state = build();
    for (let i = 0; i < 3; i += 1) state.recordFailure(FailureKind.RATE_LIMIT, 0);
    assert.equal(state.allowsRequest(59_000), false);
    assert.equal(state.allowsRequest(61_000), true);
    assert.equal(state.phase, ProviderPhase.HALF_OPEN);
    assert.equal(state.health(61_000), 0.5);
  });

  test("a successful probe closes the breaker completely", () => {
    const state = build();
    for (let i = 0; i < 3; i += 1) state.recordFailure(FailureKind.RATE_LIMIT, 0);
    state.allowsRequest(61_000);
    state.recordSuccess(10, 61_000);
    assert.equal(state.phase, ProviderPhase.HEALTHY);
    assert.equal(state.health(61_000), 1);
  });

  test("a failed half-open probe reopens immediately, regardless of threshold", () => {
    const state = build();
    state.recordFailure(FailureKind.TIMEOUT, 0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    state.recordFailure(FailureKind.TIMEOUT, 0);
    state.allowsRequest(31_000); // -> half-open
    state.recordFailure(FailureKind.TIMEOUT, 31_000);
    assert.equal(state.phase, ProviderPhase.OPEN, "a failed probe is a failed request");
  });
});

describe("ProviderState — operator control", () => {
  test("draining stops new work but keeps the provider registered", () => {
    const state = build();
    state.recordSuccess(10, 0);
    assert.ok(state.drain());
    assert.equal(state.allowsRequest(0), false);
    assert.equal(state.status(0), ProviderStatus.DISABLED);
  });

  test("a draining provider ignores call outcomes", () => {
    // In-flight work finishing must not resurrect a provider an operator
    // deliberately took out.
    const state = build();
    state.drain();
    state.recordSuccess(10, 0);
    assert.equal(state.phase, ProviderPhase.DRAINING);
  });

  test("resuming returns to unproven, not to healthy", () => {
    const state = build();
    state.recordSuccess(10, 0);
    state.drain();
    assert.ok(state.resume());
    assert.equal(state.phase, ProviderPhase.REGISTERED);
    assert.equal(state.health(0), 0.75, "it has to earn healthy back");
  });

  test("resume only applies to a draining provider", () => {
    const state = build();
    assert.equal(state.resume(), false);
  });

  test("an unconfigured provider cannot be drained", () => {
    assert.equal(build({ configured: false }).drain(), false);
  });
});

describe("ProviderState — status projection", () => {
  test("maps the open cause onto a client-visible status", () => {
    const quota = build();
    quota.recordFailure(FailureKind.QUOTA, 0);
    assert.equal(quota.status(0), ProviderStatus.QUOTA);

    const limited = build();
    for (let i = 0; i < 3; i += 1) limited.recordFailure(FailureKind.RATE_LIMIT, 0);
    assert.equal(limited.status(0), ProviderStatus.RATE_LIMITED);

    const down = build();
    down.recordFailure(FailureKind.OUTAGE, 0);
    down.recordFailure(FailureKind.OUTAGE, 0);
    down.recordFailure(FailureKind.OUTAGE, 0);
    assert.equal(down.status(0), ProviderStatus.OFFLINE);
  });

  test("a degraded provider still reads as ready", () => {
    // Degraded is an internal ranking signal, not something a user should see
    // as an outage.
    const state = build();
    state.recordFailure(FailureKind.TIMEOUT, 0);
    assert.equal(state.status(0), ProviderStatus.READY);
  });

  test("the snapshot exposes status, never the raw phase alone", () => {
    const state = build();
    state.recordSuccess(42, 1000);
    const snapshot = state.snapshot(1000);
    assert.equal(snapshot.status, ProviderStatus.READY);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.latencyMs, 42);
    assert.equal(snapshot.health, 1);
  });

  test("respects a custom failure threshold", () => {
    const state = build({ failureThreshold: 1 });
    state.recordFailure(FailureKind.TIMEOUT, 0);
    assert.equal(state.phase, ProviderPhase.OPEN);
  });
});
