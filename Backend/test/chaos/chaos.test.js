import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider, mockDescriptor } from "../helpers/mockProvider.js";
import { Adapter } from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * The five chaos exercises
 * ([12](../../../docs/backend/12-testing.md#chaos-exercises)), automated.
 *
 * The document says "run against staging, quarterly". Quarterly manual
 * exercises are the ones that get skipped in a busy quarter — and the quarter
 * they get skipped is the one where the behaviour silently regressed. Automated
 * here, they run on every commit; the pipeline runs the same file against
 * staging, where the failures are real processes rather than substituted ones.
 *
 * **Exercise 5 validates the product thesis.** If saturating one provider does
 * not shift traffic away from it, health-driven ranking is not working and the
 * entire multi-provider premise is decorative.
 */

/** A second provider, distinct from `mock`, with its own model ids. */
function provider(id, settings = {}) {
  const descriptor = new ProviderDescriptor({
    ...mockDescriptor,
    id,
    name: `Mock ${id}`,
    models: mockDescriptor.models.map((m) => ({ ...m, id: `${id}-${m.id}` })),
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

const answered = async (app, message = "chaos") => {
  const { status, body } = await app.post("/api/v1/chat", { message });
  return { status, provider: body?.meta?.provider ?? null };
};

describe("chaos 1 — a provider is disabled", () => {
  test("chat keeps working when any single provider goes away", async () => {
    // The whole architecture exists so that this is a non-event. If it is not,
    // nothing else in the fleet design is worth having.
    const ids = ["alpha", "bravo", "charlie"];
    const app = await startApp({ providers: ids.map((id) => provider(id)) });

    try {
      for (const victim of ids) {
        app.providerRegistry.disable(victim);

        const result = await answered(app, `without ${victim}`);
        assert.equal(result.status, 200, `chat broke without ${victim}`);
        assert.notEqual(result.provider, victim, "traffic still went to the disabled provider");

        app.providerRegistry.enable(victim);
      }
    } finally {
      await app.close();
    }
  });
});

describe("chaos 2 — all but one provider is disabled", () => {
  test("routing converges on the survivor", async () => {
    const app = await startApp({
      providers: [provider("alpha"), provider("bravo"), provider("charlie")],
    });

    try {
      app.providerRegistry.disable("alpha");
      app.providerRegistry.disable("bravo");

      for (let i = 0; i < 5; i += 1) {
        const result = await answered(app, `survivor ${i}`);
        assert.equal(result.status, 200);
        assert.equal(result.provider, "charlie");
      }
    } finally {
      await app.close();
    }
  });

  test("with none left, the error is clear rather than a hang", async () => {
    const app = await startApp({ providers: [provider("alpha")] });
    try {
      app.providerRegistry.disable("alpha");

      const { status, body } = await app.post("/api/v1/chat", { message: "nobody home" });
      assert.equal(status, 503);
      assert.equal(body.error.kind, "provider_unavailable");
      assert.ok(body.error.traceId, "an error a user reports must be findable");
    } finally {
      await app.close();
    }
  });
});

describe("chaos 3 — the cache goes away under load", () => {
  test("no request fails while the counter store is unreachable", async () => {
    // Redis holds rate-limit counters and shared breaker state. Losing it
    // degrades the platform to per-instance limits; it must not break it
    // (docs/backend/08-storage.md#redis-must-be-optional-and-what-that-costs).
    const app = await startApp({ providers: [provider("alpha")] });

    try {
      const working = { get: app.cache.get.bind(app.cache), increment: app.cache.increment.bind(app.cache) };

      // Down.
      app.cache.get = async () => null;
      app.cache.increment = async () => null;

      const during = await Promise.all(
        Array.from({ length: 10 }, (_, i) => answered(app, `during outage ${i}`))
      );
      assert.ok(during.every((r) => r.status === 200), "chat failed while the cache was down");

      // Back.
      app.cache.get = working.get;
      app.cache.increment = working.increment;

      const after = await answered(app, "after recovery");
      assert.equal(after.status, 200);
    } finally {
      await app.close();
    }
  });

  test("sign-in fails closed while chat fails open", async () => {
    // The asymmetry is the decision, and it is worth re-asserting here: this is
    // the exercise where an operator would discover it the hard way.
    const app = await startApp({ providers: [provider("alpha")] });
    try {
      await app.post(
        "/api/v1/auth/register",
        { email: "chaos@novagpt.test", password: "a-long-enough-passphrase" },
        { anonymous: true }
      );

      app.cache.get = async () => null;
      app.cache.increment = async () => null;

      const chat = await answered(app, "still working");
      const login = await app.post(
        "/api/v1/auth/login",
        { email: "chaos@novagpt.test", password: "a-long-enough-passphrase" },
        { anonymous: true }
      );

      assert.equal(chat.status, 200);
      assert.equal(login.status, 429);
    } finally {
      await app.close();
    }
  });
});

describe("chaos 4 — the instance dies mid-stream", () => {
  test("the client sees the stream end, not a hang", async () => {
    // A hung request is the worst failure mode available: the user waits, the
    // client holds a connection, and nothing times out for minutes. A dropped
    // connection at least lets the client retry immediately.
    const app = await startApp({
      providers: [buildMockProvider({ latencyMs: 300, defaultText: "one two three four five" })],
    });

    const token = (await app.principal()).token;
    const started = Date.now();

    const streaming = app.sse("/api/v1/chat/stream", { message: "kill me" }, { token });

    // Long enough to be mid-stream, far short of completion.
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The abrupt kind: no drain, no graceful shutdown. This is a SIGKILL, a
    // node eviction, or an OOM — not a deploy.
    app.server.closeAllConnections?.();
    app.server.close();

    let ended = false;
    try {
      await streaming;
      ended = true;
    } catch {
      // A transport error is a perfectly good outcome — it is *terminating*.
      ended = true;
    }

    assert.ok(ended, "the stream never ended");
    assert.ok(Date.now() - started < 5000, "the client hung waiting for a dead instance");
  });
});

describe("chaos 5 — one provider's rate limit is saturated", () => {
  test("traffic shifts away automatically", async () => {
    // **The exercise that validates the product thesis.** If this does not
    // hold, health-driven ranking is not working and the multi-provider premise
    // is decorative.
    const saturated = provider("saturated");
    const healthy = provider("healthy");

    // Every call to the first provider is rate-limited, as a real provider
    // would behave once a burst pushed it past its per-minute ceiling.
    saturated.script(Array.from({ length: 200 }, () => ({ fail: "rate_limit" })));

    const app = await startApp({ providers: [saturated, healthy] });
    try {
      const used = [];
      for (let i = 0; i < 8; i += 1) {
        const result = await answered(app, `shift ${i}`);
        assert.equal(result.status, 200, "a saturated provider must not fail the request");
        used.push(result.provider);
      }

      // The first request may still try the saturated provider and fail over —
      // that is correct. What must not happen is *every* request paying that
      // cost, which is what a fleet with no health memory would do.
      const later = used.slice(3);
      assert.ok(
        later.every((p) => p === "healthy"),
        `traffic did not shift away: ${used.join(", ")}`
      );
    } finally {
      await app.close();
    }
  });

  test("the shift is visible in the metrics an operator watches", async () => {
    // Behaviour that is correct but invisible cannot be confirmed during an
    // incident, which makes it indistinguishable from behaviour that is broken.
    const saturated = provider("saturated");
    saturated.script(Array.from({ length: 50 }, () => ({ fail: "rate_limit" })));

    const app = await startApp({ providers: [saturated, provider("healthy")] });
    try {
      await answered(app, "make it fail over");

      const rendered = await app.metrics.render();
      assert.match(rendered, /nova_routing_failovers_total\{[^}]*reason="rate_limit"/);
      assert.match(rendered, /nova_provider_breaker_state/);
    } finally {
      await app.close();
    }
  });
});
