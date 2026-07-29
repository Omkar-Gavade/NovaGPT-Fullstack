import { test } from "node:test";
import assert from "node:assert/strict";

import { registry, Status } from "../providers/registry/index.js";
import { route, resolveModel, rankCandidates, SwitchPolicy } from "../providers/router/ModelRouter.js";
import { ProviderError, FailureKind } from "../providers/interfaces/Provider.js";
import { CATALOG } from "../providers/registry/catalog.js";

/** Force a provider "configured" and reset its breaker for deterministic tests. */
function arm(id) {
  const p = registry.get(id);
  if (p.requiresKey !== false) p.apiKey = "test-key";
  registry.state.get(id).breaker.onSuccess();
}

/* --------------------------------- registry ------------------------------ */

test("registry loads all 18 providers and the full catalog", () => {
  assert.equal(registry.snapshot().length, 18);
  assert.equal(registry.catalogWithStatus().length, 24);
});

test("all Phase-6 free providers are registered and expose the interface", () => {
  const free = ["cerebras", "github", "nvidia", "cloudflare", "cohere", "zhipu", "huggingface"];
  for (const id of free) {
    const p = registry.get(id);
    assert.ok(p, `missing provider ${id}`);
    for (const m of ["generate", "stream", "vision", "toolCalling", "listModels", "health"]) {
      assert.equal(typeof p[m], "function", `${id}.${m} missing`);
    }
  }
});

test("every catalog model belongs to a registered provider", () => {
  const ids = new Set(registry.snapshot().map((p) => p.id));
  for (const m of CATALOG) assert.ok(ids.has(m.provider), `${m.id} -> unknown provider ${m.provider}`);
});

test("every catalog model resolves to a provider", () => {
  for (const model of CATALOG) assert.ok(registry.forModel(model.id), `no provider for ${model.id}`);
});

test("snapshot exposes full capability flags and never leaks secrets", () => {
  const gemini = registry.snapshot().find((p) => p.id === "gemini");
  assert.deepEqual(
    Object.keys(gemini.capabilities).sort(),
    ["embeddings", "json", "reasoning", "streaming", "tools", "vision"]
  );
  assert.equal("apiKey" in gemini, false);
  assert.equal("baseURL" in gemini, false);
});

test("capability flags are accurate per provider", () => {
  assert.equal(registry.get("gemini").supportsEmbeddings(), true);
  assert.equal(registry.get("claude").supportsEmbeddings(), false);
  assert.equal(registry.get("ollama").supportsEmbeddings(), true); // has embeddingModel
});

/* ------------------------------ circuit breaker -------------------------- */

test("breaker opens on quota and reports quota_reached status", () => {
  arm("gemini");
  registry.recordFailure("gemini", new ProviderError("quota", FailureKind.QUOTA));
  assert.equal(registry.isAvailable("gemini"), false);
  assert.equal(registry.statusOf("gemini"), Status.QUOTA);
  registry.recordSuccess("gemini", 10); // recovery
  assert.equal(registry.statusOf("gemini"), Status.READY);
});

test("breaker opens only after threshold for transient failures", () => {
  arm("groq");
  registry.recordFailure("groq", new ProviderError("blip", FailureKind.OUTAGE));
  registry.recordFailure("groq", new ProviderError("blip", FailureKind.OUTAGE));
  assert.equal(registry.isAvailable("groq"), true); // 2 < threshold(3)
  registry.recordFailure("groq", new ProviderError("blip", FailureKind.OUTAGE));
  assert.equal(registry.isAvailable("groq"), false);
  registry.recordSuccess("groq", 10);
});

/* ---------------------------------- router ------------------------------- */

test("resolveModel honours a usable user preference", () => {
  arm("gemini");
  assert.equal(resolveModel("gemini-2.5-flash").id, "gemini-2.5-flash");
});

test("ranking prefers healthy providers", () => {
  arm("gemini");
  arm("groq");
  registry.recordFailure("groq", new ProviderError("x", FailureKind.QUOTA)); // groq unhealthy
  const ranked = rankCandidates({});
  assert.ok(ranked.every((m) => registry.isAvailable(m.provider)));
  assert.ok(!ranked.some((m) => m.provider === "groq"));
  registry.recordSuccess("groq", 10);
});

test("capability filter excludes models that can't do the job", () => {
  const visionOnly = rankCandidates({ requiresVision: true });
  assert.ok(visionOnly.every((m) => m.vision));
});

/* --------------------------------- failover ------------------------------ */

test("auto policy fails over and reports the switch", async () => {
  arm("gemini");
  arm("groq");
  const attempts = [];
  const { model, switched } = await route("generate", {
    modelId: "gemini-2.5-flash",
    switchPolicy: SwitchPolicy.AUTO,
    invoke: async (provider, m) => {
      attempts.push(m.id);
      if (provider.id === "gemini") throw new ProviderError("Gemini quota reached", FailureKind.QUOTA, { provider: "gemini" });
      return { text: "ok" };
    },
  });
  assert.equal(attempts[0], "gemini-2.5-flash");
  assert.notEqual(model.provider, "gemini");
  assert.match(switched.message, /Gemini.*Switched to/);
  registry.recordSuccess("gemini", 10);
});

test("never policy throws instead of switching", async () => {
  arm("gemini");
  await assert.rejects(
    route("generate", {
      modelId: "gemini-2.5-flash",
      switchPolicy: SwitchPolicy.NEVER,
      invoke: async () => { throw new ProviderError("quota", FailureKind.QUOTA); },
    }),
    /quota/
  );
  registry.recordSuccess("gemini", 10);
});

test("ask policy returns a confirmation with a suggestion", async () => {
  arm("gemini");
  arm("groq");
  try {
    await route("generate", {
      modelId: "gemini-2.5-flash",
      switchPolicy: SwitchPolicy.ASK,
      invoke: async (p) => {
        if (p.id === "gemini") throw new ProviderError("quota reached", FailureKind.QUOTA);
        return {};
      },
    });
    assert.fail("should have thrown a confirmation");
  } catch (err) {
    assert.equal(err.requiresConfirmation, true);
    assert.ok(err.suggestion?.id);
  }
  registry.recordSuccess("gemini", 10);
});

test("auth failure is not retried or failed over", async () => {
  arm("gemini");
  let calls = 0;
  await assert.rejects(
    route("generate", {
      modelId: "gemini-2.5-flash",
      switchPolicy: SwitchPolicy.AUTO,
      invoke: async () => { calls += 1; throw new ProviderError("bad key", FailureKind.AUTH, { provider: "gemini" }); },
    })
  );
  assert.equal(calls, 1);
  registry.recordSuccess("gemini", 10);
});

test("a cancelled request is not failed over", async () => {
  arm("gemini");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    route("generate", {
      modelId: "gemini-2.5-flash",
      switchPolicy: SwitchPolicy.AUTO,
      signal: ac.signal,
      invoke: async () => ({ text: "unreachable" }),
    }),
    /cancelled/i
  );
});
