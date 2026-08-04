import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RoutingPolicy } from "../../src/domain/routing/RoutingPolicy.js";
import { RoutingMode } from "../../src/domain/routing/RoutingDecision.js";
import { ErrorKind } from "../../src/domain/errors/index.js";
import {
  model,
  snapshot,
  allHealthy,
  requirements,
  noRequirements,
  basicCatalog,
} from "../helpers/routingFixtures.js";

/**
 * The decision table, row by row.
 *
 * Each test is named for its row number in
 * docs/backend/04-router.md#every-routing-decision-enumerated. That shared index
 * is deliberate: when a routing bug is found, the fix is to correct the row in
 * the documentation *and* the test carrying its number, so the two cannot drift.
 *
 * Any routing behaviour not covered by a numbered row here is, by definition, a
 * bug — either in the code or in the table.
 */

const policy = new RoutingPolicy();
const decide = (input) => policy.decide(input);

describe("routing decision table", () => {
  test("1 — a pinned, healthy, capable model is used", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
      preferredModelId: "beta-vision",
    });
    // Explicit intent beats inference, even though alpha-fast ranks higher.
    assert.equal(decision.primary.id, "beta-vision");
    assert.equal(decision.mode, RoutingMode.PINNED);
  });

  test("2 — a pinned model whose breaker is open is overridden, and it is reported", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog, { beta: { available: false, status: "quota_reached" } }),
      preferredModelId: "beta-vision",
    });
    assert.equal(decision.primary.id, "alpha-fast");
    assert.equal(decision.mode, RoutingMode.OVERRIDDEN);
    assert.match(decision.reason, /unavailable \(quota_reached\)/);
  });

  test("3 — a pinned model lacking a required capability is a hard error, not a substitution", () => {
    // Silently substituting would hand the user output from a model they did
    // not choose, for a reason they cannot see.
    const catalog = basicCatalog();
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: requirements({ vision: true }),
          snapshot: allHealthy(catalog),
          preferredModelId: "alpha-fast",
        }),
      (error) => {
        assert.equal(error.kind, ErrorKind.UNSUPPORTED_CAPABILITY);
        assert.match(error.message, /cannot satisfy/);
        assert.deepEqual(error.details.alternatives, ["beta-vision"]);
        return true;
      }
    );
  });

  test("4 — a pinned model on an unconfigured provider falls back, listing why", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog, { beta: { available: false, status: "unconfigured" } }),
      preferredModelId: "beta-vision",
    });
    assert.equal(decision.primary.id, "alpha-fast");
    assert.match(decision.reason, /unconfigured/);
  });

  test("5 — with no preference and eligible models, the top-ranked wins", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
    });
    assert.equal(decision.primary.id, "alpha-fast");
    assert.equal(decision.mode, RoutingMode.AUTOMATIC);
    assert.equal(decision.consideredCount, 2);
  });

  test("6 — no eligible model produces an error naming why each was excluded", () => {
    const catalog = basicCatalog();
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: noRequirements(),
          snapshot: snapshot({
            alpha: { available: false, status: "offline" },
            beta: { available: false, status: "quota_reached" },
          }),
        }),
      (error) => {
        assert.equal(error.kind, ErrorKind.PROVIDER_UNAVAILABLE);
        // The diagnostic is the value: it must say which providers and why.
        const statuses = error.details.providers.map((p) => p.status).sort();
        assert.deepEqual(statuses, ["offline", "quota_reached"]);
        return true;
      }
    );
  });

  test("7 — requirements no model can meet name the unsatisfiable constraint", () => {
    const catalog = basicCatalog();
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: requirements({ audio: true }),
          snapshot: allHealthy(catalog),
        }),
      (error) => {
        assert.equal(error.kind, ErrorKind.UNSUPPORTED_CAPABILITY);
        assert.match(error.message, /audio/);
        return true;
      }
    );
  });

  test("18 — a context window larger than any model reports the best available", () => {
    const catalog = [
      model("small", { provider: "alpha", capabilities: { contextWindow: 8_000 } }),
      model("large", { provider: "beta", capabilities: { contextWindow: 256_000 } }),
    ];
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: requirements({ contextWindow: 1_000_000 }),
          snapshot: allHealthy(catalog),
        }),
      (error) => {
        const best = error.details.unsatisfiable.find((u) => u.capability === "contextWindow");
        // Turns a dead end into an actionable message.
        assert.equal(best.bestAvailable.value, 256_000);
        assert.equal(best.bestAvailable.modelId, "large");
        return true;
      }
    );
  });

  test("17 — an empty catalog says to add an API key", () => {
    assert.throws(
      () => decide({ catalog: [], requirements: noRequirements(), snapshot: snapshot({}) }),
      (error) => {
        assert.match(error.message, /Add a provider API key/);
        return true;
      }
    );
  });

  test("16 — providers already tried are excluded from re-selection", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
      exclude: ["alpha"],
    });
    assert.equal(decision.primary.id, "beta-vision");
    assert.ok(decision.chain.every((m) => m.provider !== "alpha"));
  });

  test("13 — when every capable provider has been tried, the error says so", () => {
    const catalog = basicCatalog();
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: noRequirements(),
          snapshot: allHealthy(catalog),
          exclude: ["alpha", "beta"],
        }),
      (error) => {
        assert.match(error.message, /already been tried/);
        assert.deepEqual(error.details.tried, ["alpha", "beta"]);
        return true;
      }
    );
  });

  test("19 — a capability served only by an unavailable provider is distinguished from incapable", () => {
    // "Nothing is up" and "nothing can do this" have different fixes; conflating
    // them sends the operator looking in the wrong place.
    const catalog = basicCatalog();
    assert.throws(
      () =>
        decide({
          catalog,
          requirements: requirements({ vision: true }),
          snapshot: allHealthy(catalog, { beta: { available: false, status: "offline" } }),
        }),
      (error) => {
        assert.equal(error.kind, ErrorKind.PROVIDER_UNAVAILABLE, "capable but down, not incapable");
        assert.equal(error.details.capableModels, 1);
        return true;
      }
    );
  });

  test("20 — a half-open provider is selectable, since the probe is the request", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog, {
        alpha: { available: true, health: 0.5, status: "ready" },
        beta: { available: true, health: 1 },
      }),
    });
    // Half-open is available but deprioritised: healthy beta outranks it.
    assert.equal(decision.primary.id, "beta-vision");
    assert.ok(decision.fallbacks.some((m) => m.provider === "alpha"));
  });

  test("a deprecated model never wins automatic selection but stays in the catalog", () => {
    const catalog = [
      model("retired", { provider: "alpha", deprecated: true, replacedBy: "current" }),
      model("current", { provider: "beta" }),
    ];
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
    });
    assert.equal(decision.primary.id, "current");
    assert.ok(decision.rejected.some((r) => r.reason === "deprecated"));
  });

  test("pinning an unknown model falls back rather than failing", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
      preferredModelId: "does-not-exist",
    });
    assert.equal(decision.mode, RoutingMode.OVERRIDDEN);
    assert.match(decision.reason, /not a known model/);
  });
});

describe("routing decision — chain construction", () => {
  test("fallbacks are pre-computed against the same snapshot as the primary", () => {
    // Ranking a fallback against fresher state than its primary would make
    // failover irreproducible from the logs.
    const catalog = [
      model("a", { provider: "pa", capabilities: { speed: 90 } }),
      model("b", { provider: "pb", capabilities: { speed: 80 } }),
      model("c", { provider: "pc", capabilities: { speed: 70 } }),
    ];
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
    });
    assert.deepEqual(decision.chain.map((m) => m.id), ["a", "b", "c"]);
  });

  test("the chain is capped at the attempt budget", () => {
    const catalog = ["a", "b", "c", "d", "e"].map((id) => model(id, { provider: `p${id}` }));
    const decision = new RoutingPolicy({ maxCandidates: 3 }).decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
    });
    assert.equal(decision.maxAttempts, 3);
  });

  test("a pinned primary still receives ranked fallbacks", () => {
    const catalog = basicCatalog();
    const decision = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
      preferredModelId: "beta-vision",
    });
    assert.equal(decision.primary.id, "beta-vision");
    assert.deepEqual(decision.fallbacks.map((m) => m.id), ["alpha-fast"]);
  });

  test("the decision logs its own rationale", () => {
    const catalog = basicCatalog();
    const log = decide({
      catalog,
      requirements: noRequirements(),
      snapshot: allHealthy(catalog),
    }).toLog();
    assert.equal(log.model, "alpha-fast");
    assert.ok(log.reason.length > 0);
    assert.equal(log.consideredCount, 2);
    assert.ok(Array.isArray(log.fallbacks));
  });

  test("rejections are bounded so a large catalog stays loggable", () => {
    const catalog = Array.from({ length: 40 }, (_, i) =>
      model(`m${i}`, { provider: `p${i}`, capabilities: { vision: false } })
    );
    catalog.push(model("visual", { provider: "vp", capabilities: { vision: true } }));
    const decision = decide({
      catalog,
      requirements: requirements({ vision: true }),
      snapshot: allHealthy(catalog),
    });
    assert.equal(decision.primary.id, "visual");
    assert.ok(decision.rejected.length <= 5, `got ${decision.rejected.length}`);
  });
});
