import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";

/**
 * The acceptance criterion, as a test.
 *
 * > One trace id reconstructs a full request across all layers, including every
 * > failover attempt.
 *
 * Everything below is about whether that sentence is true of a real request
 * over a real socket, rather than whether the tracer works in isolation.
 */

const named = (trace) => trace.spans.map((s) => s.name);

describe("tracing over HTTP", () => {
  test("one request produces one trace covering every layer", async () => {
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "trace me" });

      const trace = app.traces.at(-1);
      assert.ok(trace, "a completed request must produce a trace");

      // The call path, top to bottom. A missing one here means an operator
      // reading the trace cannot see where the time went.
      for (const name of [
        "http.request",
        "thread.load",
        "routing.decide",
        "context.assemble",
        "provider.invoke",
        "thread.persist",
      ]) {
        assert.ok(named(trace).includes(name), `missing span: ${name}`);
      }

      // One trace id across all of them — the whole point.
      assert.equal(new Set(trace.spans.map((s) => s.traceId)).size, 1);
    } finally {
      await app.close();
    }
  });

  test("the root span covers the whole request, not the middleware chain", async () => {
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "how long" });

      const trace = app.traces.at(-1);
      const root = trace.spans.find((s) => s.parentSpanId === null);
      const provider = trace.spans.find((s) => s.name === "provider.invoke");

      assert.equal(root.name, "http.request");
      // Ending the root when `next()` returns would time microseconds and make
      // the provider span longer than the request containing it.
      assert.ok(root.durationMs >= provider.durationMs, `${root.durationMs} < ${provider.durationMs}`);
      assert.equal(root.attributes["http.status_code"], 200);
      assert.equal(root.attributes["http.route"], "/api/v1/chat");
    } finally {
      await app.close();
    }
  });

  test("attributes explain the routing decision without a second query", async () => {
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "why this model" });

      const decide = app.traces.at(-1).spans.find((s) => s.name === "routing.decide");
      assert.equal(decide.attributes["routing.provider"], "mock");
      assert.ok(decide.attributes["routing.model"]);
      assert.ok(decide.attributes["routing.candidates"] >= 1);
    } finally {
      await app.close();
    }
  });

  test("every failover attempt is its own span, numbered", async () => {
    const primary = buildMockProvider();
    primary.script([{ fail: "timeout" }]);
    const app = await startApp({ providers: [primary] });

    try {
      await app.post("/api/v1/chat", { message: "retry me" });

      const attempts = app.traces
        .at(-1)
        .spans.filter((s) => s.name === "provider.invoke")
        .sort((a, b) => a.attributes["provider.attempt"] - b.attributes["provider.attempt"]);

      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].attributes["provider.attempt"], 1);
      assert.equal(attempts[0].attributes["provider.outcome"], "failure");
      assert.equal(attempts[0].attributes["provider.failure_kind"], "timeout");
      assert.equal(attempts[1].attributes["provider.outcome"], "success");
    } finally {
      await app.close();
    }
  });

  test("a streaming request records time to first token as a marker", async () => {
    const app = await startApp();
    try {
      await app.sse("/api/v1/chat/stream", { message: "stream me" });

      const trace = app.traces.at(-1);
      const marker = trace.spans.flatMap((s) => s.events ?? []).find((e) => e.name === "stream.first_token");

      assert.ok(marker, "TTFT is the number users feel; it must be on the trace");
      assert.ok(marker.attributes.ttftMs >= 0);
    } finally {
      await app.close();
    }
  });

  test("a failed request is traced, and marked as failed", async () => {
    const app = await startApp({ providers: [] });
    try {
      const { status } = await app.post("/api/v1/chat", { message: "nobody home" });
      assert.equal(status, 503);

      const root = app.traces.at(-1).spans.find((s) => s.parentSpanId === null);
      assert.equal(root.attributes["http.status_code"], 503);
    } finally {
      await app.close();
    }
  });

  test("no span attribute carries prompt or completion text", async () => {
    // Attribute values must be low-cardinality identifiers — for privacy, and
    // because high-cardinality attributes make a tracing backend expensive
    // (docs/backend/11-observability.md#span-attributes).
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "a distinctive secret phrase" });

      const serialised = JSON.stringify(app.traces.at(-1));
      assert.ok(!serialised.includes("distinctive secret phrase"));
      assert.ok(!serialised.includes("mock response"));
    } finally {
      await app.close();
    }
  });

  test("the trace id on an error response is the one in the logs", async () => {
    // This is what turns "something went wrong" into a single log query — the
    // highest-leverage observability feature in the system per line of code.
    const app = await startApp();
    try {
      const { body } = await app.json("/api/v1/threads/does-not-exist");
      assert.ok(body.error.traceId);

      const logged = app.logger.lines.filter((l) => l.traceId === body.error.traceId);
      assert.ok(logged.length > 0, "the id a user reports must find its request");
    } finally {
      await app.close();
    }
  });
});
