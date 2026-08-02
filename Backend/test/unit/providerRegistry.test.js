import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../../src/infrastructure/providers/registry/ProviderRegistry.js";
import { ModelRegistry } from "../../src/infrastructure/providers/catalog/ModelRegistry.js";
import { ProviderFactory } from "../../src/infrastructure/providers/registry/ProviderFactory.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { RequirementSet } from "../../src/domain/capability/RequirementSet.js";
import { BaseProvider } from "../../src/infrastructure/providers/shared/BaseProvider.js";
import { ProviderStatus } from "../../src/domain/provider/ProviderState.js";
import { ProviderError, FailureKind } from "../../src/domain/errors/ProviderError.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";
import { recordingLogger } from "../helpers/testDoubles.js";

class StubProvider extends BaseProvider {}

function makeProvider(id, { models = [], configured = true } = {}) {
  const descriptor = new ProviderDescriptor({
    id,
    name: id,
    envKeys: [`${id.toUpperCase()}_KEY`],
    requiresCredentials: true,
  });
  return new StubProvider({
    descriptor,
    models: models.map((m) => new ModelDescriptor({ ...m, provider: id })),
    credential: configured ? { expose: () => "k", redacted: "[REDACTED]" } : null,
  });
}

function build() {
  const clock = new FakeClock(0);
  const logger = recordingLogger();
  const modelRegistry = new ModelRegistry();
  const registry = new ProviderRegistry({ clock, logger, modelRegistry });
  return { clock, logger, modelRegistry, registry };
}

describe("ProviderRegistry — dynamic registration", () => {
  test("registers a provider and its models together", () => {
    const { registry, modelRegistry } = build();
    registry.register(makeProvider("alpha", { models: [{ id: "alpha-1" }, { id: "alpha-2" }] }));

    assert.equal(registry.size, 1);
    assert.ok(registry.has("alpha"));
    assert.equal(modelRegistry.size, 2);
  });

  test("unregistering removes the provider's models too", () => {
    // A catalog outliving its provider would let the router select a model
    // served by something that no longer exists.
    const { registry, modelRegistry } = build();
    registry.register(makeProvider("alpha", { models: [{ id: "alpha-1" }] }));
    assert.ok(registry.unregister("alpha"));
    assert.equal(registry.size, 0);
    assert.equal(modelRegistry.size, 0);
  });

  test("unregistering an unknown provider is a no-op, not an error", () => {
    assert.equal(build().registry.unregister("ghost"), false);
  });

  test("re-registering replaces the instance and discards its health record", () => {
    // A new instance with a fresh, untested key has not earned the old one's
    // score.
    const { registry, clock } = build();
    registry.register(makeProvider("alpha"));
    registry.recordSuccess("alpha", 50);
    assert.equal(registry.health("alpha"), 1);

    registry.register(makeProvider("alpha"));
    assert.equal(registry.health("alpha"), 0.75, "back to unproven");
  });

  test("resolves the provider serving a model", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha", { models: [{ id: "alpha-1" }] }));
    assert.equal(registry.forModel("alpha-1")?.id, "alpha");
    assert.equal(registry.forModel("nope"), null);
  });

  test("rejects a provider with no id", () => {
    assert.throws(() => build().registry.register({}), /must have an id/);
  });
});

describe("ProviderRegistry — availability", () => {
  test("an unconfigured provider is never available", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha", { configured: false }));
    assert.equal(registry.isAvailable("alpha"), false);
    assert.equal(registry.statusOf("alpha"), ProviderStatus.UNCONFIGURED);
  });

  test("available() lists only usable providers", () => {
    const { registry } = build();
    registry.register(makeProvider("good"));
    registry.register(makeProvider("bad"));
    registry.recordFailure("bad", new ProviderError("out", FailureKind.QUOTA));

    assert.deepEqual(registry.available().map((p) => p.id), ["good"]);
  });

  test("a provider recovers automatically once its cooldown elapses", () => {
    const { registry, clock } = build();
    registry.register(makeProvider("alpha"));
    registry.recordFailure("alpha", new ProviderError("quota", FailureKind.QUOTA));
    assert.equal(registry.isAvailable("alpha"), false);

    clock.advance(15 * 60_000 + 1);
    assert.equal(registry.isAvailable("alpha"), true, "half-open lets one request through");
  });

  test("records latency for ranking", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha"));
    registry.recordSuccess("alpha", 100);
    registry.recordSuccess("alpha", 200);
    assert.equal(registry.averageLatencyMs("alpha"), 150);
  });

  test("logs a breaker transition rather than every failure", () => {
    // A quota failure is normal operation on a free tier; the breaker opening
    // is the event an operator cares about.
    const { registry, logger } = build();
    registry.register(makeProvider("alpha"));
    registry.recordFailure("alpha", new ProviderError("quota", FailureKind.QUOTA));
    const events = logger.find("providers.registry.phase_changed");
    assert.equal(events.length, 1);
    assert.equal(events[0].to, "open");
  });
});

describe("ProviderRegistry — operator control", () => {
  test("disable drains without unregistering", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha", { models: [{ id: "alpha-1" }] }));
    assert.ok(registry.disable("alpha"));

    assert.equal(registry.isAvailable("alpha"), false);
    assert.ok(registry.has("alpha"), "still registered — in-flight work finishes");
    assert.equal(registry.statusOf("alpha"), ProviderStatus.DISABLED);
  });

  test("enable returns it to rotation as unproven", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha"));
    registry.disable("alpha");
    assert.ok(registry.enable("alpha"));
    assert.equal(registry.isAvailable("alpha"), true);
    assert.equal(registry.health("alpha"), 0.75);
  });
});

describe("ProviderRegistry — snapshot", () => {
  test("never leaks a credential or an endpoint", () => {
    const { registry } = build();
    registry.register(makeProvider("alpha", { models: [{ id: "alpha-1" }] }));
    const json = JSON.stringify(registry.snapshot());
    assert.ok(!json.includes("expose"));
    assert.ok(!/api[_-]?key|secret|baseURL|credential/i.test(json), json);
  });

  test("includes skipped providers with a reason", () => {
    // A provider that is absent for a fixable reason must be visible, not
    // silently missing.
    const { registry } = build();
    registry.recordSkipped(new ProviderDescriptor({ id: "beta", name: "Beta" }), "no credential");
    const snapshot = registry.snapshot();
    assert.equal(snapshot.skipped[0].id, "beta");
    assert.equal(snapshot.skipped[0].reason, "no credential");
    assert.equal(snapshot.total, 1);
  });
});

describe("ModelRegistry", () => {
  const model = (id, provider, capabilities = {}) => ({ id, provider, capabilities });

  test("bumps its version on every mutation, for cache invalidation", () => {
    const registry = new ModelRegistry();
    assert.equal(registry.version, 0);
    registry.register(model("a", "p"));
    assert.equal(registry.version, 1);
    registry.unregisterProvider("p");
    assert.equal(registry.version, 2);
  });

  test("refuses to let a second provider claim an existing model id", () => {
    // Two providers fighting over one id makes routing non-deterministic in a
    // way no log would explain.
    const registry = new ModelRegistry();
    registry.register(model("shared", "alpha"));
    assert.throws(() => registry.register(model("shared", "beta")), /already registered/);
  });

  test("allows a provider to replace its own model row", () => {
    const registry = new ModelRegistry();
    registry.register(model("a", "p", { vision: false }));
    registry.register(model("a", "p", { vision: true }));
    assert.equal(registry.get("a").supports("vision"), true);
  });

  test("filters by requirements", () => {
    const registry = new ModelRegistry();
    registry.register(model("text", "p", { contextWindow: 8000 }));
    registry.register(model("visual", "p", { vision: true, contextWindow: 128_000 }));

    const matches = registry.matching(new RequirementSet({ vision: true }));
    assert.deepEqual(matches.map((m) => m.id), ["visual"]);
  });

  test("excludes deprecated models from automatic selection but keeps them retrievable", () => {
    // A conversation pinned to a retired model must keep working rather than
    // failing with "unknown model".
    const registry = new ModelRegistry();
    registry.register({ ...model("old", "p"), deprecated: true, replacedBy: "new" });
    assert.equal(registry.selectable().length, 0);
    assert.equal(registry.get("old").replacedBy, "new");
  });

  test("explains why nothing matched", () => {
    const registry = new ModelRegistry();
    registry.register(model("small", "p", { contextWindow: 8000 }));
    const reasons = registry.explainMismatch(new RequirementSet({ contextWindow: 200_000 }));
    assert.equal(reasons[0].unmet[0].capability, "contextWindow");
    assert.equal(reasons[0].unmet[0].actual, 8000);
  });

  test("reports the best numeric on offer, for an actionable error", () => {
    const registry = new ModelRegistry();
    registry.register(model("small", "p", { contextWindow: 8000 }));
    registry.register(model("big", "q", { contextWindow: 256_000 }));
    assert.deepEqual(registry.bestNumeric("contextWindow"), {
      value: 256_000,
      modelId: "big",
      provider: "q",
    });
  });

  test("reports which providers cover a capability — the failover question", () => {
    const registry = new ModelRegistry();
    registry.register(model("a", "alpha", { vision: true }));
    registry.register(model("b", "beta", { vision: true }));
    registry.register(model("c", "gamma", {}));
    assert.deepEqual(registry.providersSupporting("vision").sort(), ["alpha", "beta"]);
  });
});

describe("ProviderFactory", () => {
  const descriptor = new ProviderDescriptor({
    id: "alpha",
    name: "Alpha",
    envKeys: ["ALPHA_KEY", "ALPHA_TOKEN"],
    models: [{ id: "alpha-1", capabilities: { contextWindow: 1000 } }],
  });

  const factory = (options = {}) =>
    new ProviderFactory({ logger: recordingLogger(), clock: new FakeClock(0), ...options });

  test("constructs when a credential is present", () => {
    const { provider, configured } = factory({ env: { ALPHA_KEY: "secret" } }).create(
      descriptor,
      StubProvider
    );
    assert.ok(provider);
    assert.equal(configured, true);
    assert.equal(provider.models.length, 1);
  });

  test("accepts any declared alias, first match wins", () => {
    const { provider } = factory({ env: { ALPHA_TOKEN: "secret" } }).create(descriptor, StubProvider);
    assert.ok(provider, "an alias must work without special-casing anywhere else");
  });

  test("wraps the credential so it cannot be logged by accident", () => {
    const { provider } = factory({ env: { ALPHA_KEY: "sk-secret-value" } }).create(
      descriptor,
      StubProvider
    );
    assert.equal(String(provider.credential), "[REDACTED:ALPHA_KEY]");
    assert.equal(provider.credential.expose(), "sk-secret-value");
  });

  test("skips with an actionable reason when no credential is present", () => {
    const { provider, reason } = factory({ env: {} }).create(descriptor, StubProvider);
    assert.equal(provider, null);
    assert.match(reason, /ALPHA_KEY/, "the reason must name the fix");
  });

  test("a provider needing no credential is constructed anyway", () => {
    const local = new ProviderDescriptor({ id: "local", name: "Local", requiresCredentials: false });
    const { provider } = factory({ env: {} }).create(local, StubProvider);
    assert.ok(provider);
  });

  test("respects an explicit per-provider disable", () => {
    const { provider, reason } = factory({
      env: { ALPHA_KEY: "k" },
      providerConfig: { alpha: { enabled: false } },
    }).create(descriptor, StubProvider);
    assert.equal(provider, null);
    assert.match(reason, /disabled by configuration/);
  });

  test("an allowlist excludes everything not named in it", () => {
    const { provider, reason } = factory({
      env: { ALPHA_KEY: "k" },
      policy: { allowlist: ["beta"] },
    }).create(descriptor, StubProvider);
    assert.equal(provider, null);
    assert.match(reason, /PROVIDERS_ENABLED/);
  });

  test("a denylist beats an allowlist", () => {
    // An operator taking a provider out during an incident must not be
    // overridden by an allowlist configured months earlier.
    const { provider, reason } = factory({
      env: { ALPHA_KEY: "k" },
      policy: { allowlist: ["alpha"], denylist: ["alpha"] },
    }).create(descriptor, StubProvider);
    assert.equal(provider, null);
    assert.match(reason, /PROVIDERS_DISABLED/);
  });

  test("drops an invalid model row without losing the provider", () => {
    const broken = new ProviderDescriptor({
      id: "alpha",
      name: "Alpha",
      envKeys: ["ALPHA_KEY"],
      models: [{ id: "good" }, { id: "bad", capabilities: { vision: "yes" } }],
    });
    const logger = recordingLogger();
    const { provider } = new ProviderFactory({
      env: { ALPHA_KEY: "k" },
      logger,
      clock: new FakeClock(0),
    }).create(broken, StubProvider);

    assert.equal(provider.models.length, 1, "one bad row must not remove a working provider");
    assert.equal(logger.find("providers.factory.invalid_model").length, 1);
  });

  test("a constructor that throws is reported, not propagated", () => {
    class Exploding extends BaseProvider {
      constructor() {
        super(...arguments);
        throw new Error("boom");
      }
    }
    const { provider, reason } = factory({ env: { ALPHA_KEY: "k" } }).create(descriptor, Exploding);
    assert.equal(provider, null);
    assert.match(reason, /construction failed/);
  });

  test("never reads process.env directly", () => {
    process.env.ALPHA_KEY = "leaked-from-globals";
    try {
      const { provider } = factory({ env: {} }).create(descriptor, StubProvider);
      assert.equal(provider, null, "the factory must use its injected env only");
    } finally {
      delete process.env.ALPHA_KEY;
    }
  });
});
