import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as ollama from "../../src/infrastructure/providers/adapters/ollama/index.js";
import { ProviderFactory } from "../../src/infrastructure/providers/registry/ProviderFactory.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * Ollama is the one provider enabled by an **endpoint** rather than a key.
 *
 * Everything else in the fleet follows "a provider is enabled by having a
 * credential". A local runtime has no credential to have, and the interesting
 * question is whether that exception weakens the rule it is an exception to.
 */

const descriptor = new ProviderDescriptor(ollama.descriptor);

const factory = (env) =>
  new ProviderFactory({
    policy: { allowlist: null, denylist: [] },
    env,
    logger: silentLogger,
    clock: new SystemClock(),
  });

describe("ollama adapter", () => {
  test("is skipped when no endpoint is configured", () => {
    // The failure this prevents: a provider registered with nothing listening,
    // which fails every request the router sends it. `requiresCredentials:
    // false` alone would have registered it unconditionally.
    const result = factory({}).create(descriptor, ollama.Adapter);

    assert.equal(result.provider, null);
    assert.equal(result.configured, false);
    assert.match(result.reason, /no endpoint/);
  });

  test("registers once an endpoint is set", () => {
    const result = factory({ OLLAMA_BASE_URL: "http://localhost:11434" }).create(
      descriptor,
      ollama.Adapter
    );

    assert.ok(result.provider);
    assert.equal(result.configured, true);
  });

  test("the endpoint is not wrapped as a credential", () => {
    // Wrapping a non-secret would train readers to reach for `.expose()`
    // without thinking, which is the habit the Secret wrapper exists to
    // prevent (docs/backend/10-security.md).
    const { provider } = factory({ OLLAMA_BASE_URL: "http://localhost:11434" }).create(
      descriptor,
      ollama.Adapter
    );

    assert.equal(provider.credential, null);
    assert.equal(provider.baseURL, "http://localhost:11434/v1");
  });

  test("accepts the URL an operator would actually paste", () => {
    // Getting this wrong produces a 404 that reads like the model is missing.
    const cases = [
      ["http://localhost:11434", "http://localhost:11434/v1"],
      ["http://localhost:11434/", "http://localhost:11434/v1"],
      ["http://localhost:11434/v1", "http://localhost:11434/v1"],
      ["http://ollama:11434/v1/", "http://ollama:11434/v1"],
    ];

    for (const [input, expected] of cases) {
      const { provider } = factory({ OLLAMA_BASE_URL: input }).create(descriptor, ollama.Adapter);
      assert.equal(provider.baseURL, expected, `for ${input}`);
    }
  });

  test("sends no Authorization header", () => {
    // A local endpoint has no credential, and sending an empty bearer token
    // would be a header some proxies reject.
    const { provider } = factory({ OLLAMA_BASE_URL: "http://localhost:11434" }).create(
      descriptor,
      ollama.Adapter
    );

    assert.equal(provider.headersFor({}).Authorization, undefined);
  });

  test("allows far longer than a hosted provider would", () => {
    // Ollama serves one generation at a time per model, so a second request
    // queues behind the first. A 60s budget tuned for hosted APIs would time
    // out a local model that was working correctly, just slowly.
    const { provider } = factory({ OLLAMA_BASE_URL: "http://localhost:11434" }).create(
      descriptor,
      ollama.Adapter
    );

    assert.ok(provider.timeoutMs >= 300_000);
  });

  test("claims no capability it cannot deliver, and no optimistic scores", () => {
    // A local 8B model is slower and weaker than any hosted frontier model.
    // An optimistic score routes real traffic to it before it has earned any.
    for (const model of descriptor.models) {
      if (model.capabilities.speed !== undefined) {
        assert.ok(model.capabilities.speed <= 50, `${model.id} claims speed ${model.capabilities.speed}`);
      }
      assert.equal(model.verifiedAt, null, `${model.id} has never been verified from this repository`);
    }
  });
});
