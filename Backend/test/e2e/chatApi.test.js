import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";
import { Adapter, descriptor as mockDescriptor } from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * The product API, over real HTTP.
 *
 * Real Express, real middleware, real orchestrator, real routing and context
 * engines. Only the provider and the store are substituted, and both are real
 * implementations of their ports — so this exercises the production path a
 * browser would take.
 */

function secondProvider(id = "mock-b", settings = {}) {
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

describe("chat API — send", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("creates a thread on the first message", async () => {
    const { status, body } = await app.post("/api/v1/chat", { message: "first question" });
    assert.equal(status, 200);
    assert.ok(body.data.threadId);
    assert.equal(body.data.message.role, "assistant");
    assert.equal(body.data.message.content, "mock response");
    assert.equal(body.meta.model, "mock-standard");
  });

  test("the thread is persisted with both turns", async () => {
    const send = await app.post("/api/v1/chat", { message: "persist me" });
    const { body } = await app.json(`/api/v1/threads/${send.body.data.threadId}`);

    assert.equal(body.data.messages.length, 2);
    assert.equal(body.data.messages[0].role, "user");
    assert.equal(body.data.messages[1].role, "assistant");
    assert.equal(body.data.title, "persist me");
  });

  test("a second message continues the same thread", async () => {
    const first = await app.post("/api/v1/chat", { message: "turn one" });
    const threadId = first.body.data.threadId;
    await app.post("/api/v1/chat", { threadId, message: "turn two" });

    const { body } = await app.json(`/api/v1/threads/${threadId}`);
    assert.equal(body.data.messages.length, 4);
    assert.equal(body.data.messages[2].content, "turn two");
  });

  test("assistant messages carry routing and context diagnostics", async () => {
    // The glass box: a user can see why this model answered and what it got.
    const { body } = await app.post("/api/v1/chat", { message: "explain yourself" });
    assert.ok(body.data.message.routing.reason);
    assert.ok(body.data.message.context.estimatedTokens > 0);
    assert.ok(body.data.message.context.promptBudget > 0);
  });

  test("per-request settings override without mutating the thread", async () => {
    const send = await app.post("/api/v1/chat", {
      message: "one-off",
      settings: { temperature: 0.1 },
    });
    const { body } = await app.json(`/api/v1/threads/${send.body.data.threadId}/settings`);
    assert.equal(body.data.temperature, 0.7, "a per-request value must not persist");
  });

  test("rejects an unknown field rather than ignoring it", async () => {
    // Silently stripping `temperture` gives default behaviour and a bug report
    // nobody can reproduce.
    const { status, body } = await app.post("/api/v1/chat", {
      message: "hi",
      temperture: 0.9,
    });
    assert.equal(status, 400);
    assert.equal(body.error.kind, "validation");
  });

  test("rejects an empty message", async () => {
    const { status } = await app.post("/api/v1/chat", { message: "" });
    assert.equal(status, 400);
  });

  test("every error carries a trace id", async () => {
    const { body } = await app.post("/api/v1/chat", { message: "" });
    assert.ok(body.error.traceId);
  });
});

describe("chat API — streaming", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("streams SSE with the correct headers", async () => {
    const { response } = await app.sse("/api/v1/chat/stream", { message: "stream this" });
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    // Without no-transform a proxy buffers the whole stream and delivers it at
    // the end, defeating streaming while looking like a slow backend.
    assert.match(response.headers.get("cache-control"), /no-transform/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
  });

  test("emits the stream id before any token", async () => {
    // Without it the client cannot stop the stream.
    const { events } = await app.sse("/api/v1/chat/stream", { message: "hello" });
    assert.equal(events[0].type, "stream");
    assert.ok(events[0].streamId);
    assert.ok(events[0].threadId);
  });

  test("emits start, deltas, usage and exactly one terminal", async () => {
    const { events } = await app.sse("/api/v1/chat/stream", { message: "hello" });
    const types = events.map((e) => e.type);

    assert.ok(types.includes("start"));
    assert.ok(types.filter((t) => t === "delta").length > 0);
    assert.equal(
      types.filter((t) => t === "done" || t === "error").length,
      1,
      "neither leaves the client with an unresolvable spinner"
    );
    assert.equal(types.at(-1), "done");
  });

  test("persists the assembled reply when the stream completes", async () => {
    const { events } = await app.sse("/api/v1/chat/stream", { message: "save this" });
    const threadId = events[0].threadId;

    const { body } = await app.json(`/api/v1/threads/${threadId}`);
    assert.equal(body.data.messages.length, 2);
    assert.equal(body.data.messages[1].content, "mock response");
  });

  test("a routing failure before the first token is a normal HTTP error", async () => {
    // Nothing is committed yet, so a status code is still possible and is more
    // useful than an SSE error frame.
    const empty = await startApp({ providers: [] });
    try {
      const { status, body } = await empty.post("/api/v1/chat/stream", { message: "nobody home" });
      assert.equal(status, 503);
      assert.equal(body.error.kind, "provider_unavailable");
    } finally {
      await empty.close();
    }
  });
});

describe("chat API — failover is visible", () => {
  test("a switch is reported to the client mid-stream", async () => {
    const primary = buildMockProvider({ defaultText: "partial one two" });
    primary.script([{ failAfterChunks: 1 }]);
    const app = await startApp({
      providers: [primary, secondProvider("mock-b", { defaultText: "the real answer" })],
    });

    try {
      const { events } = await app.sse("/api/v1/chat/stream", { message: "fail over" });
      const switched = events.find((e) => e.type === "switched");

      assert.ok(switched, "failover is never silent");
      assert.equal(switched.discardPartial, true);

      // Only the surviving attempt's text is stored — two models do not
      // continue each other's sentences.
      const { body } = await app.json(`/api/v1/threads/${events[0].threadId}`);
      assert.equal(body.data.messages[1].content, "the real answer");
    } finally {
      await app.close();
    }
  });

  test("a non-streaming failover reports which model answered", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "quota" }]);
    const app = await startApp({ providers: [primary, secondProvider()] });

    try {
      const { body } = await app.post("/api/v1/chat", { message: "quota please" });
      assert.ok(body.data.switched);
      assert.equal(body.data.switched.reason, "quota");
      assert.equal(body.meta.provider, "mock-b");
    } finally {
      await app.close();
    }
  });
});

describe("chat API — stop", () => {
  test("stops an in-flight stream without persisting a partial reply", async () => {
    // Slow enough that the abort lands mid-stream rather than after it.
    const provider = buildMockProvider({ latencyMs: 400, defaultText: "a b c d e f g h" });
    const app = await startApp({ providers: [provider] });

    try {
      const controller = new AbortController();
      const streaming = app.sse("/api/v1/chat/stream", { message: "long one" }, {
        signal: controller.signal,
      });

      // Long enough to register the stream, far short of its completion.
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await streaming.catch(() => {});

      await new Promise((r) => setTimeout(r, 60));
      const { body } = await app.json("/api/v1/threads");
      const thread = body.data[0];
      if (thread) {
        const full = await app.json(`/api/v1/threads/${thread.id}`);
        // A half-written assistant turn would corrupt the thread and then
        // become context for every later turn.
        const assistant = full.body.data.messages.filter((m) => m.role === "assistant");
        assert.equal(assistant.length, 0, "a cancelled stream must persist nothing");
      }
    } finally {
      await app.close();
    }
  });

  test("stopping an unknown stream reports false rather than 404", async () => {
    const app = await startApp();
    try {
      const { status, body } = await app.post("/api/v1/chat/stop", { streamId: "does-not-exist" });
      assert.equal(status, 200);
      assert.equal(body.data.stopped, false);
    } finally {
      await app.close();
    }
  });
});

describe("chat API — regenerate and continue", () => {
  test("regenerate rewinds and replaces the assistant turn", async () => {
    const provider = buildMockProvider();
    const app = await startApp({ providers: [provider] });

    try {
      const send = await app.post("/api/v1/chat", { message: "ask once" });
      const threadId = send.body.data.threadId;
      const messageId = send.body.data.message.id;

      provider.script([{ text: "a different answer" }]);
      const again = await app.post("/api/v1/chat/regenerate", { threadId, messageId });

      assert.equal(again.status, 200);
      assert.equal(again.body.data.message.content, "a different answer");

      // Still exactly one turn pair: the old answer was replaced, not appended.
      const { body } = await app.json(`/api/v1/threads/${threadId}`);
      assert.equal(body.data.messages.length, 2);
    } finally {
      await app.close();
    }
  });

  test("regenerate refuses a user message", async () => {
    const app = await startApp();
    try {
      const send = await app.post("/api/v1/chat", { message: "hello" });
      const threadId = send.body.data.threadId;
      const { body } = await app.json(`/api/v1/threads/${threadId}`);
      const userMessageId = body.data.messages[0].id;

      const { status } = await app.post("/api/v1/chat/regenerate", {
        threadId,
        messageId: userMessageId,
      });
      assert.equal(status, 400);
    } finally {
      await app.close();
    }
  });

  test("continue extends a truncated reply in place", async () => {
    const provider = buildMockProvider();
    provider.script([{ text: "first half", finishReason: "length" }]);
    const app = await startApp({ providers: [provider] });

    try {
      const send = await app.post("/api/v1/chat", { message: "long answer please" });
      const threadId = send.body.data.threadId;
      assert.equal(send.body.data.message.finishReason, "length");

      provider.script([{ text: " and second half" }]);
      const continued = await app.post("/api/v1/chat/continue", { threadId });

      assert.equal(continued.body.data.message.content, "first half and second half");

      // Appended to the existing turn: two consecutive assistant messages are
      // malformed dialogue.
      const { body } = await app.json(`/api/v1/threads/${threadId}`);
      assert.equal(body.data.messages.length, 2);
    } finally {
      await app.close();
    }
  });

  test("continue refuses a reply that finished on its own", async () => {
    const app = await startApp();
    try {
      const send = await app.post("/api/v1/chat", { message: "short" });
      const { status, body } = await app.post("/api/v1/chat/continue", {
        threadId: send.body.data.threadId,
      });
      assert.equal(status, 400);
      assert.match(body.error.message, /finished on its own/);
    } finally {
      await app.close();
    }
  });
});
