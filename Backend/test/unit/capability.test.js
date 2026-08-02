import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityRegistry,
  capabilityRegistry,
} from "../../src/domain/capability/CapabilityRegistry.js";
import { CapabilitySet } from "../../src/domain/capability/CapabilitySet.js";
import { RequirementSet } from "../../src/domain/capability/RequirementSet.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { CapabilityKind } from "../../src/domain/capability/Capability.js";

describe("CapabilityRegistry", () => {
  test("declares the documented axes", () => {
    for (const name of ["vision", "streaming", "json", "structuredOutput", "toolCalling"]) {
      assert.equal(capabilityRegistry.kindOf(name), CapabilityKind.BINARY, name);
    }
    assert.equal(capabilityRegistry.kindOf("contextWindow"), CapabilityKind.NUMERIC);
    assert.equal(capabilityRegistry.kindOf("reasoning"), CapabilityKind.SCORED);
  });

  test("rejects an unknown capability rather than storing it", () => {
    // An untyped bag is how `vision: "yes"` passes silently and fails at
    // routing time.
    assert.deepEqual(capabilityRegistry.validate({ telepathy: true }), [
      'unknown capability "telepathy"',
    ]);
  });

  test("enforces the type of each kind", () => {
    assert.match(capabilityRegistry.validate({ vision: "yes" })[0], /must be a boolean/);
    assert.match(capabilityRegistry.validate({ contextWindow: "128k" })[0], /positive number/);
    assert.match(capabilityRegistry.validate({ reasoning: 150 })[0], /score 0-100/);
  });

  test("reports every problem at once", () => {
    const problems = capabilityRegistry.validate({ vision: 1, reasoning: -5, nope: true });
    assert.equal(problems.length, 3);
  });

  test("enforces implications, which cannot be half-true", () => {
    // A model enforcing a schema necessarily produces valid JSON. Letting the
    // pair disagree would satisfy a schema requirement with a model that has
    // said it cannot produce parseable output.
    const problems = capabilityRegistry.validate({ structuredOutput: true, json: false });
    assert.match(problems[0], /implies "json"/);
  });

  test("scored axes may not be used as filters", () => {
    assert.ok(capabilityRegistry.isFilterable("vision"));
    assert.ok(capabilityRegistry.isFilterable("contextWindow"));
    assert.ok(!capabilityRegistry.isFilterable("reasoning"));
  });

  test("undeclared binaries normalise to false, never true", () => {
    // Over-advertising costs a failed request and a wasted quota unit;
    // under-advertising costs a marginally worse route. Silence means no.
    const normalised = capabilityRegistry.normalise({ vision: true });
    assert.equal(normalised.vision, true);
    assert.equal(normalised.toolCalling, false);
    assert.equal(normalised.audio, false);
  });

  test("supports registering a new axis at runtime", () => {
    const registry = new CapabilityRegistry();
    registry.register({ name: "telepathy", kind: CapabilityKind.BINARY });
    assert.ok(registry.has("telepathy"));
    assert.deepEqual(registry.validate({ telepathy: true }), []);
  });

  test("refuses to redeclare an existing axis", () => {
    // Two subsystems disagreeing about what `vision` means is worse than a
    // startup error.
    const registry = new CapabilityRegistry();
    assert.throws(() => registry.register({ name: "vision", kind: CapabilityKind.BINARY }), /already registered/);
  });

  test("rejects an axis with an unknown kind", () => {
    const registry = new CapabilityRegistry();
    assert.throws(() => registry.register({ name: "x", kind: "vibes" }), /Unknown capability kind/);
  });
});

describe("CapabilitySet", () => {
  test("validates on construction", () => {
    assert.throws(() => new CapabilitySet({ vision: "yes" }), /Invalid capabilities/);
  });

  test("reports support and scores", () => {
    const set = new CapabilitySet({ vision: true, reasoning: 90, contextWindow: 128_000 });
    assert.ok(set.supports("vision"));
    assert.ok(!set.supports("audio"));
    assert.equal(set.score("reasoning"), 90);
    assert.equal(set.value("contextWindow"), 128_000);
  });

  test("an unscored axis ranks mid-pack rather than last", () => {
    assert.equal(new CapabilitySet({}).score("reasoning"), 50);
  });

  test("narrow removes claims", () => {
    const set = new CapabilitySet({ vision: true, json: true });
    const narrowed = set.narrow(["vision"]);
    assert.ok(!narrowed.supports("vision"));
    assert.ok(narrowed.supports("json"));
  });

  test("narrow cannot add a claim", () => {
    // Probes and adapters cannot know a capability the catalog did not
    // declare; inferring one from a model name is string matching against a
    // convention no provider guarantees.
    const set = new CapabilitySet({ vision: false });
    assert.ok(!set.narrow(["audio"]).supports("audio"));
  });

  test("is immutable", () => {
    const set = new CapabilitySet({ vision: true });
    assert.ok(Object.isFrozen(set.values));
    assert.throws(() => {
      set.values.vision = false;
    }, TypeError);
  });
});

describe("RequirementSet", () => {
  const capable = new CapabilitySet({
    vision: true,
    json: true,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
  });

  test("is satisfied when every requirement is met", () => {
    assert.ok(new RequirementSet({ vision: true, contextWindow: 64_000 }).satisfiedBy(capable));
  });

  test("is unsatisfied on a missing binary", () => {
    const unmet = new RequirementSet({ audio: true }).unmetBy(capable);
    assert.deepEqual(unmet, [{ capability: "audio", required: true, actual: false }]);
  });

  test("is unsatisfied on an insufficient numeric", () => {
    const unmet = new RequirementSet({ contextWindow: 200_000 }).unmetBy(capable);
    assert.deepEqual(unmet, [{ capability: "contextWindow", required: 200_000, actual: 128_000 }]);
  });

  test("refuses a scored axis as a requirement", () => {
    // The scores are maintainer estimates, not a calibrated scale; gating on
    // one produces confidently wrong exclusions.
    assert.throws(() => new RequirementSet({ reasoning: 85 }), /cannot be a requirement/);
  });

  test("refuses an unknown capability", () => {
    assert.throws(() => new RequirementSet({ telepathy: true }), /unknown capability/);
  });

  test("refuses a negative binary requirement", () => {
    assert.throws(() => new RequirementSet({ vision: false }), /must be required as true/);
  });

  describe("derivation from a request", () => {
    test("images imply vision", () => {
      const requirements = RequirementSet.from({ attachments: [{ type: "image" }] });
      assert.deepEqual(requirements.toJSON(), { vision: true });
    });

    test("tools imply toolCalling", () => {
      assert.deepEqual(RequirementSet.from({ tools: [{ name: "t" }] }).toJSON(), {
        toolCalling: true,
      });
    });

    test("a schema implies structuredOutput, plain json implies json", () => {
      assert.ok(RequirementSet.from({ responseFormat: { type: "json_schema" } }).required.structuredOutput);
      assert.ok(RequirementSet.from({ responseFormat: { type: "json" } }).required.json);
    });

    test("token estimates become window requirements", () => {
      const requirements = RequirementSet.from({ estimatedPromptTokens: 90_000, maxTokens: 2048 });
      assert.equal(requirements.required.contextWindow, 90_000);
      assert.equal(requirements.required.maxOutputTokens, 2048);
    });

    test("a plain text request requires nothing", () => {
      // Derivation is conservative: it asks only what the content proves, so a
      // simple request keeps the widest candidate set.
      assert.ok(RequirementSet.from({}).isEmpty);
    });
  });
});

describe("ModelDescriptor", () => {
  test("requires an id and a provider", () => {
    assert.throws(() => new ModelDescriptor({}), /id is required/);
    assert.throws(() => new ModelDescriptor({ id: "m" }), /provider is required/);
  });

  test("rejects an invalid tier or cost band", () => {
    assert.throws(() => new ModelDescriptor({ id: "m", provider: "p", tier: "cheap" }), /tier must be/);
    assert.throws(() => new ModelDescriptor({ id: "m", provider: "p", costBand: "£" }), /costBand must be/);
  });

  test("propagates capability validation failures", () => {
    assert.throws(
      () => new ModelDescriptor({ id: "m", provider: "p", capabilities: { vision: 1 } }),
      /Invalid model "m"|Invalid capabilities/
    );
  });

  test("exposes limits through named accessors", () => {
    const model = new ModelDescriptor({
      id: "m",
      provider: "p",
      capabilities: { contextWindow: 128_000, maxOutputTokens: 8192 },
    });
    assert.equal(model.contextWindow, 128_000);
    assert.equal(model.maxOutputTokens, 8192);
  });

  test("a deprecated model is not automatically selectable", () => {
    const model = new ModelDescriptor({ id: "m", provider: "p", deprecated: true, replacedBy: "m2" });
    assert.equal(model.isSelectable, false);
    assert.equal(model.replacedBy, "m2");
  });

  test("is immutable", () => {
    const model = new ModelDescriptor({ id: "m", provider: "p" });
    assert.throws(() => {
      model.id = "other";
    }, TypeError);
  });
});
