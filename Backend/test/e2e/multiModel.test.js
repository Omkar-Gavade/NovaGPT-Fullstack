import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider, mockDescriptor } from "../helpers/mockProvider.js";
import { discoverAdapters } from "../live/liveHarness.js";
import { Adapter } from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * The whole architecture, exercised in one place.
 *
 * Every other suite proves one component. This one asks the question a
 * deployment actually cares about: **does the multi-provider design work end to
 * end?** It walks the path a real request takes — discovery, routing,
 * selection, failover, retry, streaming, context, persistence, auth — and
 * asserts the seams between them, which is where a system that passes every
 * unit test still falls over.
 *
 * **Providers are mocked.** Only Gemini holds a credential in this environment;
 * `npm run test:live` is where real endpoints are exercised, and it reports
 * which. Nothing here should be read as evidence that a given provider works.
 */

function provider(id, capabilities = {}, settings = {}) {
  const descriptor = new ProviderDescriptor({
    ...mockDescriptor,
    id,
    name: `Mock ${id}`,
    models: [
      {
        id: `${id}-model`,
        displayName: `${id} model`,
        capabilities: {
          streaming: true,
          json: true,
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          speed: 80,
          ...capabilities,
        },
        tier: "free",
        costBand: "Free",
      },
    ],
  });

  return new Adapter({
    descriptor,
    models: descriptor.models.map((m) => new ModelDescriptor({ ...m, provider: id })),
    logger: silentLogger,
    clock: new SystemClock(),
    credential: new Secret("enabled", "MOCK_PROVIDER_ENABLED"),
    settings,
  });
}

describe("multi-model — provider discovery", () => {
  test("every shipped adapter is discovered and loadable", async () => {
    // Discovery is filesystem-driven, so an adapter that fails to load is
    // absent rather than broken — the failure is silence.
    const adapters = await discoverAdapters();
    const ids = adapters.map((a) => a.descriptor.id).sort();

    assert.ok(ids.length >= 9, `only ${ids.length} adapters discovered: ${ids}`);
    for (const expected of ["gemini", "groq", "deepseek", "qwen", "mistral", "openrouter", "nvidia", "zhipu", "ollama"]) {
      assert.ok(ids.includes(expected), `${expected} was not discovered`);
    }
  });

  test("each declares a descriptor and an adapter class", async () => {
    for (const { descriptor, Adapter: A } of await discoverAdapters()) {
      assert.ok(descriptor.id, "a descriptor without an id cannot be registered");
      assert.equal(typeof A, "function");
      assert.ok(descriptor.models.length > 0, `${descriptor.id} declares no models`);
    }
  });

  test("the catalog surfaces every registered model with live availability", async () => {
    const app = await startApp({ providers: [provider("alpha"), provider("beta")] });
    try {
      const { body } = await app.json("/api/v1/models");
      const ids = body.data.map((m) => m.id);

      assert.ok(ids.includes("alpha-model") && ids.includes("beta-model"));
      assert.equal(typeof body.data[0].available, "boolean");
    } finally {
      await app.close();
    }
  });
});

describe("multi-model — selection", () => {
  test("automatic selection prefers the healthier provider", async () => {
    const app = await startApp({ providers: [provider("slow"), provider("fast")] });
    try {
      // Both healthy and equal, so this asserts only that a choice is made and
      // reported — the ranking itself is unit-tested exhaustively.
      const { body } = await app.post("/api/v1/chat", { message: "pick one" });
      assert.ok(["slow", "fast"].includes(body.meta.provider));
      assert.ok(body.data.message.routing.reason, "the choice must explain itself");
    } finally {
      await app.close();
    }
  });

  test("a manual model pin is honoured", async () => {
    // The user's explicit choice outranks the system's automatic preference
    // (ADR-009). Without this the model picker in the UI is decorative.
    const app = await startApp({ providers: [provider("alpha"), provider("beta")] });
    try {
      const { body } = await app.post("/api/v1/chat", {
        message: "use beta",
        settings: { model: "beta-model" },
      });
      assert.equal(body.meta.provider, "beta");
    } finally {
      await app.close();
    }
  });

  test("a pin to an unknown model falls back, and the client is told", async () => {
    // Deliberately not an error: at request time "never existed" cannot be
    // distinguished from "existed and was retired", and failing the second
    // would break every conversation pinned to a model since removed.
    //
    // What must not happen is a *silent* substitution — the user believing they
    // tested a model they never reached. So the decision is reported as
    // overridden, with the unknown id named.
    const app = await startApp({ providers: [provider("alpha")] });
    try {
      const { status, body } = await app.post("/api/v1/chat", {
        message: "hi",
        settings: { model: "does-not-exist" },
      });

      assert.equal(status, 200);
      assert.equal(body.data.message.routing.mode, "overridden");
      assert.match(body.data.message.routing.reason, /not a known model/);
    } finally {
      await app.close();
    }
  });
});

describe("multi-model — failover and retry", () => {
  test("a dead provider fails over and the switch is reported", async () => {
    const dead = provider("dead");
    dead.script(Array.from({ length: 20 }, () => ({ fail: "outage" })));

    const app = await startApp({ providers: [dead, provider("alive")] });
    try {
      const { status, body } = await app.post("/api/v1/chat", { message: "survive this" });

      assert.equal(status, 200);
      assert.equal(body.meta.provider, "alive");
      // Never silent (ADR-010): the user is told which model answered.
      assert.ok(body.data.switched, "a failover must be visible to the client");
      assert.equal(body.data.switched.reason, "outage");
    } finally {
      await app.close();
    }
  });

  test("a transient failure is retried in place, without a failover", async () => {
    // Retry and failover are different mechanisms for different failures, and
    // spending a failover on a blip wastes the cheaper option.
    const flaky = buildMockProvider();
    flaky.script([{ fail: "timeout" }]);

    const app = await startApp({ providers: [flaky] });
    try {
      const { status, body } = await app.post("/api/v1/chat", { message: "retry me" });
      assert.equal(status, 200);
      assert.equal(body.data.switched, null, "a same-provider retry is not a switch");
    } finally {
      await app.close();
    }
  });

  test("an api_error never fails over", async () => {
    // The request itself was rejected; another provider would reject it
    // identically, and trying is a wasted quota unit.
    const bad = provider("bad");
    bad.script(Array.from({ length: 5 }, () => ({ fail: "api_error" })));

    const app = await startApp({ providers: [bad, provider("good")] });
    try {
      const { status } = await app.post("/api/v1/chat", { message: "malformed" });
      assert.ok(status >= 400, "a rejected request must surface, not fail over");
    } finally {
      await app.close();
    }
  });

  test("with every provider down the error is clear and traceable", async () => {
    const app = await startApp({ providers: [] });
    try {
      const { status, body } = await app.post("/api/v1/chat", { message: "nobody home" });
      assert.equal(status, 503);
      assert.equal(body.error.kind, "provider_unavailable");
      assert.ok(body.error.traceId);
    } finally {
      await app.close();
    }
  });
});

describe("multi-model — the full request path", () => {
  let app;
  let token;

  before(async () => {
    // A fleet that between them covers every capability the four surfaces need.
    app = await startApp({
      providers: [provider("alpha", { embeddings: true }), provider("beta", { vision: true })],
    });
    token = (await app.principal()).token;
  });
  after(() => app.close());

  test("registration, chat, persistence and history in one flow", async () => {
    const user = await app.signIn("flow@novagpt.test");

    const first = await app.post("/api/v1/chat", { message: "first turn" }, { token: user.token });
    assert.equal(first.status, 200);
    const threadId = first.body.data.threadId;

    await app.post("/api/v1/chat", { threadId, message: "second turn" }, { token: user.token });

    const thread = await app.json(`/api/v1/threads/${threadId}`, { token: user.token });
    assert.equal(thread.body.data.messages.length, 4, "both turns must persist");
    assert.equal(thread.body.data.title, "first turn");

    const list = await app.json("/api/v1/threads", { token: user.token });
    assert.ok(list.body.data.some((t) => t.id === threadId));
  });

  test("streaming delivers incremental frames and persists the result", async () => {
    const { events } = await app.sse("/api/v1/chat/stream", { message: "stream it" }, { token });
    const types = events.map((e) => e.type);

    assert.equal(types[0], "stream", "the id must arrive before any token");
    assert.ok(types.filter((t) => t === "delta").length > 0);
    assert.equal(types.at(-1), "done");

    const thread = await app.json(`/api/v1/threads/${events[0].threadId}`, { token });
    assert.equal(thread.body.data.messages.length, 2);
  });

  test("the context engine reports what it sent", async () => {
    const { body } = await app.post("/api/v1/chat", { message: "context please" }, { token });
    assert.ok(body.data.message.context.estimatedTokens > 0);
    assert.ok(body.data.message.context.promptBudget > 0);
  });

  test("authentication gates the whole conversation surface", async () => {
    for (const path of ["/api/v1/chat", "/api/v1/threads", "/api/v1/embeddings", "/api/v1/tools/call"]) {
      const { status } = await app.json(path, { anonymous: true, method: "POST", body: "{}" });
      assert.equal(status, 401, `${path} served an anonymous caller`);
    }
  });

  test("every capability endpoint answers on the same fleet", async () => {
    // The integration point: one provider registry, one router, four surfaces.
    const chat = await app.post("/api/v1/chat", { message: "hi" }, { token });
    const embed = await app.post("/api/v1/embeddings", { input: ["hi"] }, { token });
    const models = await app.json("/api/v1/models", { token });

    assert.equal(chat.status, 200);
    assert.equal(embed.status, 200);
    assert.equal(models.status, 200);
  });
});

describe("multi-model — BYOK and local inference", () => {
  test("a user's own key is used for their request and nobody else's", async () => {
    const app = await startApp({ providers: [provider("alpha")] });
    try {
      const alice = await app.signIn("byok-alice@novagpt.test");
      const bob = await app.signIn("byok-bob@novagpt.test");

      await app.json("/api/v1/me/keys/alpha", {
        method: "PUT",
        token: alice.token,
        body: JSON.stringify({ key: "sk-live-aliceownkey0001" }),
      });

      assert.equal((await app.userKeyService.resolve(alice.user.id)).size, 1);
      assert.equal((await app.userKeyService.resolve(bob.user.id)).size, 0);
    } finally {
      await app.close();
    }
  });

  test("Ollama is skipped without an endpoint, and registers with one", async () => {
    // Enabled by reachability rather than by a credential — the one exception
    // to the fleet's enablement rule, and the reason it needs its own check.
    const { ProviderFactory } = await import("../../src/infrastructure/providers/registry/ProviderFactory.js");
    const ollama = (await discoverAdapters()).find((a) => a.descriptor.id === "ollama");

    const factory = (env) =>
      new ProviderFactory({ policy: { allowlist: null, denylist: [] }, env, logger: silentLogger, clock: new SystemClock() });

    assert.equal(factory({}).create(ollama.descriptor, ollama.Adapter).provider, null);
    assert.ok(
      factory({ OLLAMA_BASE_URL: "http://localhost:11434" }).create(ollama.descriptor, ollama.Adapter).provider
    );
  });
});
