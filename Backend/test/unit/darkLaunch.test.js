import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PromotionGate, PromotionVerdict } from "../../src/domain/provider/PromotionGate.js";
import { HealthSnapshot } from "../../src/domain/routing/HealthSnapshot.js";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { RequirementSet } from "../../src/domain/capability/RequirementSet.js";

/**
 * Shipping dark, and earning promotion out of it.
 *
 * Steps 9 and 10 of onboarding
 * ([03](../../../docs/backend/03-provider-system.md#provider-onboarding-process)).
 * The mechanism exists so a new provider accumulates real telemetry against
 * real traffic with a bounded blast radius, rather than being handed primary
 * traffic on the strength of a passing contract suite.
 */

const model = (id, provider, extra = {}) =>
  new ModelDescriptor({
    id,
    provider,
    displayName: id,
    capabilities: { streaming: true },
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    tier: "free",
    costBand: "Free",
    ...extra,
  });

const snapshot = (entries) => new HealthSnapshot(entries, 1000);

describe("dark launch — ranking", () => {
  const policy = new RoutingPolicy({ maxCandidates: 5 });
  const catalog = [model("promoted-1", "promoted"), model("dark-1", "newcomer")];

  test("a dark provider ranks below a promoted one", async () => {
    const decision = policy.decide({
      catalog,
      requirements: new RequirementSet({}),
      snapshot: snapshot([
        { providerId: "promoted", available: true, health: 1, latencyMs: 500, priority: 0 },
        { providerId: "newcomer", available: true, health: 1, latencyMs: 10, priority: 0, dark: true },
      ]),
    });

    // Faster *and* equally healthy, and it still ranks second. Speed is not
    // what dark is measuring.
    assert.equal(decision.primary.provider, "promoted");
  });

  test("it ranks below a promoted provider that is struggling", () => {
    // The ordering that matters most, and the reason darkness sits above health
    // in the chain: a brand-new provider must not take over the moment anything
    // else dips, because that is exactly the blast radius dark exists to bound.
    const decision = policy.decide({
      catalog,
      requirements: new RequirementSet({}),
      snapshot: snapshot([
        { providerId: "promoted", available: true, health: 0.4, latencyMs: 9000, priority: 0 },
        { providerId: "newcomer", available: true, health: 1, latencyMs: 50, priority: 0, dark: true },
      ]),
    });

    assert.equal(decision.primary.provider, "promoted");
  });

  test("but it is still reachable as a late failover", () => {
    // Ranked last is not excluded. A fleet with nothing else left should use
    // what it has.
    const decision = policy.decide({
      catalog,
      requirements: new RequirementSet({}),
      snapshot: snapshot([
        { providerId: "promoted", available: true, health: 1, latencyMs: 100, priority: 0 },
        { providerId: "newcomer", available: true, health: 1, latencyMs: 100, priority: 0, dark: true },
      ]),
    });

    assert.ok(
      decision.chain.some((m) => m.provider === "newcomer"),
      "a dark provider must remain in the fallback chain"
    );
  });

  test("it is the only candidate when everything promoted is unavailable", () => {
    const decision = policy.decide({
      catalog,
      requirements: new RequirementSet({}),
      snapshot: snapshot([
        { providerId: "promoted", available: false, health: 0, latencyMs: null, priority: 0 },
        { providerId: "newcomer", available: true, health: 1, latencyMs: 100, priority: 0, dark: true },
      ]),
    });

    assert.equal(decision.primary.provider, "newcomer");
  });

  test("an operator priority cannot promote a dark provider", () => {
    // Priority is a bias within the promoted fleet. Using it to jump the
    // observation window would make the gate optional, which is the same as
    // not having one.
    const decision = policy.decide({
      catalog,
      requirements: new RequirementSet({}),
      snapshot: snapshot([
        { providerId: "promoted", available: true, health: 1, latencyMs: 500, priority: 0 },
        { providerId: "newcomer", available: true, health: 1, latencyMs: 10, priority: 100, dark: true },
      ]),
    });

    assert.equal(decision.primary.provider, "promoted");
  });
});

describe("promotion gate", () => {
  const gate = new PromotionGate({
    minObservationMs: 48 * 3600_000,
    minAttempts: 100,
    maxErrorRate: 0.02,
    maxP95LatencyMs: 20_000,
  });

  const clean = {
    provider: "newcomer",
    observedMs: 50 * 3600_000,
    attempts: 500,
    failures: 2,
    p95LatencyMs: 3000,
  };

  test("promotes after a clean window with enough traffic", () => {
    const result = gate.evaluate(clean);
    assert.equal(result.verdict, PromotionVerdict.READY);
    assert.equal(result.ready, true);
  });

  test("waits when the window is not up", () => {
    const result = gate.evaluate({ ...clean, observedMs: 10 * 3600_000 });
    assert.equal(result.verdict, PromotionVerdict.NOT_YET);
    assert.match(result.reasons[0], /observation remaining/);
  });

  test("a quiet window is not a passing grade", () => {
    // Four clean attempts demonstrate nothing. This is the check that stops a
    // provider being promoted on the strength of a quiet weekend.
    const result = gate.evaluate({ ...clean, attempts: 4, failures: 0 });
    assert.equal(result.verdict, PromotionVerdict.NOT_YET);
    assert.match(result.reasons[0], /4 of 100 attempts/);
  });

  test("distinguishes 'not yet' from 'failing'", () => {
    // Different answers requiring different actions: one is wait, the other is
    // stay dark or remove.
    const failing = gate.evaluate({ ...clean, failures: 100 });
    assert.equal(failing.verdict, PromotionVerdict.FAILING);
    assert.match(failing.reasons[0], /error rate/);
  });

  test("slow is disqualifying even when nothing failed", () => {
    const result = gate.evaluate({ ...clean, p95LatencyMs: 45_000 });
    assert.equal(result.verdict, PromotionVerdict.FAILING);
    assert.match(result.reasons[0], /p95 latency/);
  });

  test("any breaker opening during observation is disqualifying", () => {
    // A provider that took itself out of rotation while carrying only failover
    // traffic will do it far more often carrying primary traffic.
    const result = gate.evaluate({ ...clean, breakerOpened: true });
    assert.equal(result.verdict, PromotionVerdict.FAILING);
    assert.match(result.reasons[0], /breaker opened/);
  });

  test("the verdict says why, in both directions", () => {
    // An operator reading "not ready" with no reason cannot act on it.
    assert.ok(gate.evaluate(clean).reasons[0].includes("attempts"));
    assert.ok(gate.evaluate({ ...clean, failures: 300 }).reasons.length > 0);
  });
});
