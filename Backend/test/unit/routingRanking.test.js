import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { model, snapshot, allHealthy, requirements, noRequirements } from "../helpers/routingFixtures.js";

/**
 * The lexicographic ranking chain, one criterion at a time.
 *
 * Each test isolates a single criterion by making every earlier one tie, which
 * is the only way to prove the *ordering* rather than just the outcome. A
 * weighted score would make these tests an exercise in reverse-engineering
 * weights; a lexicographic chain makes them two lines each
 * (docs/backend/04-router.md#ranking).
 */

const policy = new RoutingPolicy({ maxCandidates: 10 });
const rank = (catalog, snap, reqs = noRequirements()) =>
  policy.decide({ catalog, requirements: reqs, snapshot: snap }).chain.map((m) => m.id);

describe("ranking — 1. health outranks everything below it", () => {
  test("a healthy paid model beats a degraded free one", () => {
    // Free is a preference, not a mandate: never prefer a broken free provider
    // to a working paid one.
    const catalog = [
      model("free-degraded", { provider: "a", tier: "free", costBand: "Free" }),
      model("paid-healthy", { provider: "b", tier: "paid", costBand: "$$" }),
    ];
    const order = rank(catalog, snapshot({ a: { health: 0.3 }, b: { health: 1 } }));
    assert.deepEqual(order, ["paid-healthy", "free-degraded"]);
  });

  test("a healthy slow model beats a degraded fast one", () => {
    // A failure costs the attempt latency *plus* the failover attempt.
    const catalog = [
      model("fast", { provider: "a" }),
      model("slow", { provider: "b" }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { health: 0.3, latencyMs: 50 }, b: { health: 1, latencyMs: 900 } })
    );
    assert.deepEqual(order, ["slow", "fast"]);
  });

  test("health is bucketed, so noise does not reshuffle routing", () => {
    // Without quantisation a 0.98 provider outranks a 0.97 one and the ordering
    // churns on one unlucky sample.
    const catalog = [
      model("a", { provider: "pa", tier: "paid", costBand: "$$" }),
      model("b", { provider: "pb", tier: "free", costBand: "Free" }),
    ];
    const order = rank(catalog, snapshot({ pa: { health: 0.98 }, pb: { health: 0.97 } }));
    assert.deepEqual(order, ["b", "a"], "near-equal health should tie, letting tier decide");
  });
});

describe("ranking — 2. operator priority", () => {
  test("priority lifts a provider above the automatic preferences", () => {
    const catalog = [
      model("default-pick", { provider: "a" }),
      model("preferred", { provider: "b" }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { latencyMs: 10 }, b: { latencyMs: 900, priority: 10 } })
    );
    assert.deepEqual(order, ["preferred", "default-pick"]);
  });

  test("priority is a bias, not an override — it cannot resurrect an unhealthy provider", () => {
    const catalog = [
      model("healthy", { provider: "a" }),
      model("prioritised-but-sick", { provider: "b" }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { health: 1 }, b: { health: 0.3, priority: 100 } })
    );
    assert.deepEqual(order, ["healthy", "prioritised-but-sick"]);
  });

  test("priority cannot make an unavailable provider eligible at all", () => {
    const catalog = [
      model("up", { provider: "a" }),
      model("down", { provider: "b" }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: {}, b: { available: false, status: "offline", priority: 100 } })
    );
    assert.deepEqual(order, ["up"]);
  });

  test("negative priority demotes without excluding", () => {
    const catalog = [model("a", { provider: "pa" }), model("b", { provider: "pb" })];
    const order = rank(catalog, snapshot({ pa: { priority: -5 }, pb: {} }));
    assert.deepEqual(order, ["b", "a"]);
  });
});

describe("ranking — 3. tier", () => {
  test("free beats paid when health and priority tie", () => {
    const catalog = [
      model("paid", { provider: "a", tier: "paid", costBand: "$$" }),
      model("free", { provider: "b", tier: "free", costBand: "Free" }),
    ];
    assert.deepEqual(rank(catalog, allHealthy(catalog)), ["free", "paid"]);
  });
});

describe("ranking — 4. latency", () => {
  test("measured latency decides when tier ties", () => {
    const catalog = [model("slow", { provider: "a" }), model("fast", { provider: "b" })];
    const order = rank(catalog, snapshot({ a: { latencyMs: 800 }, b: { latencyMs: 90 } }));
    assert.deepEqual(order, ["fast", "slow"]);
  });

  test("measured latency beats the catalog speed score", () => {
    // Static scores are marketing numbers; measured latency describes what a
    // user will actually experience.
    const catalog = [
      model("claims-fast", { provider: "a", capabilities: { speed: 99 } }),
      model("claims-slow", { provider: "b", capabilities: { speed: 40 } }),
    ];
    const order = rank(catalog, snapshot({ a: { latencyMs: 2000 }, b: { latencyMs: 100 } }));
    assert.deepEqual(order, ["claims-slow", "claims-fast"]);
  });

  test("an unmeasured provider is estimated pessimistically from its speed score", () => {
    // It must not outrank a measured-fast provider on a guess.
    const catalog = [
      model("measured", { provider: "a", capabilities: { speed: 50 } }),
      model("unproven", { provider: "b", capabilities: { speed: 99 } }),
    ];
    const order = rank(catalog, snapshot({ a: { latencyMs: 200 }, b: { latencyMs: null } }));
    assert.deepEqual(order, ["measured", "unproven"]);
  });
});

describe("ranking — 5. cost", () => {
  test("cheaper band wins when everything above ties", () => {
    const catalog = [
      model("pricey", { provider: "a", tier: "paid", costBand: "$$$" }),
      model("cheap", { provider: "b", tier: "paid", costBand: "$" }),
    ];
    const order = rank(catalog, snapshot({ a: { latencyMs: 100 }, b: { latencyMs: 100 } }));
    assert.deepEqual(order, ["cheap", "pricey"]);
  });
});

describe("ranking — 6. capability fit", () => {
  test("prefers the least over-provisioned context window", () => {
    // Routing a small question to a huge-context model starves the long-document
    // request that arrives a minute later.
    const catalog = [
      model("huge", { provider: "a", capabilities: { contextWindow: 2_000_000 } }),
      model("right-sized", { provider: "b", capabilities: { contextWindow: 32_000 } }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { latencyMs: 100 }, b: { latencyMs: 100 } }),
      requirements({ contextWindow: 16_000 })
    );
    assert.deepEqual(order, ["right-sized", "huge"]);
  });

  test("does not spend a vision model on a text request", () => {
    const catalog = [
      model("multimodal", { provider: "a", capabilities: { vision: true } }),
      model("text-only", { provider: "b", capabilities: {} }),
    ];
    const order = rank(catalog, snapshot({ a: { latencyMs: 100 }, b: { latencyMs: 100 } }));
    assert.deepEqual(order, ["text-only", "multimodal"]);
  });

  test("a requested capability is not penalised as surplus", () => {
    const catalog = [
      model("multimodal", { provider: "a", capabilities: { vision: true } }),
      model("also-vision", { provider: "b", capabilities: { vision: true, audio: true } }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { latencyMs: 100 }, b: { latencyMs: 100 } }),
      requirements({ vision: true })
    );
    // Both satisfy vision; the one carrying an *extra* scarce capability loses.
    assert.deepEqual(order, ["multimodal", "also-vision"]);
  });
});

describe("ranking — 7. determinism", () => {
  test("fully tied models keep catalog order", () => {
    const catalog = [
      model("first", { provider: "a" }),
      model("second", { provider: "b" }),
      model("third", { provider: "c" }),
    ];
    const snap = snapshot({ a: { latencyMs: 100 }, b: { latencyMs: 100 }, c: { latencyMs: 100 } });
    assert.deepEqual(rank(catalog, snap), ["first", "second", "third"]);
  });

  test("identical inputs always produce an identical chain", () => {
    // An unstable sort makes bug reports irreproducible.
    const catalog = [
      model("a", { provider: "pa" }),
      model("b", { provider: "pb" }),
      model("c", { provider: "pc" }),
    ];
    const snap = allHealthy(catalog);
    const first = rank(catalog, snap);
    for (let i = 0; i < 20; i += 1) assert.deepEqual(rank(catalog, snap), first);
  });
});

describe("ranking — hard filter precedes all scoring", () => {
  test("an incapable model cannot outrank a capable one at any speed or price", () => {
    const catalog = [
      model("fast-incapable", { provider: "a", capabilities: { speed: 99, vision: false } }),
      model("slow-capable", { provider: "b", capabilities: { speed: 10, vision: true } }),
    ];
    const order = rank(
      catalog,
      snapshot({ a: { latencyMs: 1, health: 1 }, b: { latencyMs: 5000, health: 1 } }),
      requirements({ vision: true })
    );
    assert.deepEqual(order, ["slow-capable"]);
  });

  test("a provider missing from the snapshot is treated as unavailable", () => {
    // A model whose provider was unregistered between snapshot and decision
    // must never be selected.
    const catalog = [model("ghost", { provider: "gone" }), model("real", { provider: "here" })];
    assert.deepEqual(rank(catalog, snapshot({ here: {} })), ["real"]);
  });
});
