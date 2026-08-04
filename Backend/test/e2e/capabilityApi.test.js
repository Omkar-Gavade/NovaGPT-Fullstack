import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";

/**
 * Tool calling and embeddings, over real HTTP.
 *
 * Both go through the same router and executor as chat, which is the property
 * worth asserting: a second path that *did not* fail over would be invisible
 * until the day it mattered.
 */

describe("tool calling API", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  const TOOLS = [
    {
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  test("returns the model's intent, and says it executed nothing", async () => {
    // The boundary, stated in the response rather than only in a document: a
    // client must not read a tool call as something already done.
    const { status, body } = await app.post("/api/v1/tools/call", {
      messages: [{ role: "user", content: "weather in Pune?" }],
      tools: TOOLS,
    });

    assert.equal(status, 200);
    assert.equal(body.data.executed, false);
    assert.ok(Array.isArray(body.data.toolCalls));
  });

  test("requires at least one tool", async () => {
    const { status } = await app.post("/api/v1/tools/call", {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    assert.equal(status, 400);
  });

  test("refuses an anonymous caller", async () => {
    const { status } = await app.post(
      "/api/v1/tools/call",
      { messages: [{ role: "user", content: "hi" }], tools: TOOLS },
      { anonymous: true }
    );
    assert.equal(status, 401);
  });

  test("rejects a tool name that is not an identifier", async () => {
    // Names reach a provider's function-calling API, and several reject
    // anything outside this character set with an opaque 400.
    const { status } = await app.post("/api/v1/tools/call", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get weather; drop table", parameters: {} }],
    });
    assert.equal(status, 400);
  });

  test("routes only to a tool-capable model", async () => {
    // The mock's vision model declares no `toolCalling`, so a fleet without a
    // capable model must refuse rather than dispatch and fail.
    const { body, status } = await app.post("/api/v1/tools/call", {
      messages: [{ role: "user", content: "weather?" }],
      tools: TOOLS,
    });

    if (status === 200) assert.ok(body.meta.model, "a successful call names the model that answered");
    else assert.equal(body.error.kind, "unsupported_capability");
  });
});

describe("embeddings API", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("embeds a batch and reports the dimension count", async () => {
    // The dimensions matter to anyone storing these: a model change that
    // silently alters them is otherwise discovered at query time.
    const { status, body } = await app.post("/api/v1/embeddings", {
      input: ["hello", "world"],
    });

    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.meta.count, 2);
    assert.ok(body.meta.dimensions > 0);
    assert.equal(body.data[0].length, body.meta.dimensions);
  });

  test("is deterministic for the same input", async () => {
    // Not a property of every real provider, but it is of this one — and the
    // assertion catches a batch being silently reordered.
    const first = await app.post("/api/v1/embeddings", { input: ["stable"] });
    const second = await app.post("/api/v1/embeddings", { input: ["stable"] });
    assert.deepEqual(first.body.data[0], second.body.data[0]);
  });

  test("rejects an empty batch and an oversized one", async () => {
    assert.equal((await app.post("/api/v1/embeddings", { input: [] })).status, 400);
    assert.equal(
      (await app.post("/api/v1/embeddings", { input: Array(101).fill("x") })).status,
      400
    );
  });

  test("refuses an anonymous caller", async () => {
    const { status } = await app.post("/api/v1/embeddings", { input: ["hi"] }, { anonymous: true });
    assert.equal(status, 401);
  });

  test("records usage, so embeddings are counted like any other call", async () => {
    // Embeddings consume quota. A path that skipped accounting would make the
    // spend dashboard quietly wrong.
    const app2 = await startApp();
    try {
      await app2.post("/api/v1/embeddings", { input: ["counted"] });
      const records = await app2.usage.list({});
      assert.ok(records.length > 0, "an embeddings call produced no usage record");
    } finally {
      await app2.close();
    }
  });
});

describe("capability endpoints — limits", () => {
  test("carry their own limit, separate from chat", async () => {
    // The pools serving these are small, so a limit shared with chat would let
    // ordinary conversation exhaust a capability nothing else can serve.
    const app = await startApp({
      config: {
        rateLimit: {
          anonymousPerMinute: 100_000,
          authPerMinute: 100_000,
          chatPerMinute: 100_000,
          chatPerHour: 100_000,
          capabilityPerMinute: 2,
          visionPerMinute: 100_000,
        },
      },
    });

    try {
      await app.post("/api/v1/embeddings", { input: ["a"] });
      await app.post("/api/v1/embeddings", { input: ["b"] });
      const refused = await app.post("/api/v1/embeddings", { input: ["c"] });

      assert.equal(refused.status, 429);
      // Chat is unaffected: the budgets are genuinely separate.
      assert.equal((await app.post("/api/v1/chat", { message: "still fine" })).status, 200);
    } finally {
      await app.close();
    }
  });
});
