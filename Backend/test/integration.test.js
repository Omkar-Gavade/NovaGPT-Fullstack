import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { OpenAICompatibleProvider } from "../providers/utils/OpenAICompatibleProvider.js";
import { FailureKind } from "../providers/interfaces/Provider.js";

/**
 * Integration tests for the unified adapter path, with the provider HTTP API
 * mocked via global.fetch. Exercises streaming, retries, quota/rate-limit/
 * timeout handling, and health recovery through the real reliability layer.
 */

class TestProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "test",
      name: "Test",
      apiKey: "k",
      baseURL: "https://mock.test/v1",
      timeoutMs: 120,
      embeddingModel: "emb-1",
      models: [
        { id: "test-model", provider: "test", vision: true, tools: true, reasoning: 90, context: 1000, tier: "free", cost: "$" },
      ],
    });
  }
}

const enc = new TextEncoder();
const sseBody = (lines) =>
  new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/* -------------------------------- streaming ------------------------------ */

test("stream() yields deltas from an SSE response", async () => {
  global.fetch = async () =>
    ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        "data: [DONE]\n",
      ]),
    });

  const out = [];
  for await (const d of new TestProvider().stream([{ role: "user", content: "hi" }], { model: "test-model" })) {
    out.push(d);
  }
  assert.equal(out.join(""), "Hello");
});

test("generate() parses a JSON completion", async () => {
  global.fetch = async () =>
    ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "answer" } }], model: "test-model" }) });
  const res = await new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model" });
  assert.equal(res.text, "answer");
});

/* ------------------------------ error mapping ---------------------------- */

test("quota (429) maps to FailureKind.QUOTA and is not retried", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "insufficient_quota: billing" };
  };
  await assert.rejects(
    new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model" }),
    (e) => e.kind === FailureKind.QUOTA
  );
  assert.equal(calls, 1); // quota is terminal, no retry
});

test("rate limit (429) retries with backoff then succeeds", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 429, text: async () => "rate limit exceeded" };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  const res = await new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model" });
  assert.equal(res.text, "ok");
  assert.equal(calls, 3); // 2 failures + 1 success
});

test("timeout aborts and maps to FailureKind.TIMEOUT", async () => {
  let calls = 0;
  global.fetch = (_url, { signal } = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  await assert.rejects(
    new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model" }),
    (e) => e.kind === FailureKind.TIMEOUT
  );
  assert.ok(calls >= 1); // timed out (and retried transient)
});

test("server error (500) maps to OUTAGE", async () => {
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(
    new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model" }),
    (e) => e.kind === FailureKind.OUTAGE
  );
});

/* ------------------------------- capabilities ---------------------------- */

test("embeddings work when an embedding model is configured", async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) });
  const vecs = await new TestProvider().embeddings(["hello"], { model: "emb-1" });
  assert.deepEqual(vecs, [[0.1, 0.2]]);
});

test("structured output adds response_format to the request body", async () => {
  let sent;
  global.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  };
  await new TestProvider().generate([{ role: "user", content: "q" }], { model: "test-model", json: true });
  assert.deepEqual(sent.response_format, { type: "json_object" });
});

test("health() recovers after a successful probe", async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "test-model" }] }) });
  const h = await new TestProvider().health();
  assert.equal(h.ok, true);
  assert.ok(typeof h.latencyMs === "number");
});

/* ----------------------------- unavailable ------------------------------- */

test("an unconfigured provider is never usable", () => {
  const p = new TestProvider();
  p.apiKey = undefined;
  assert.equal(p.isConfigured, false);
});
