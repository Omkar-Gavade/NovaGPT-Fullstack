import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/httpHarness.js";
import { fakeProbe } from "../helpers/testDoubles.js";
import { ServiceState } from "../../src/domain/lifecycle/ServiceState.js";

describe("health endpoints — healthy instance", () => {
  let app;
  before(async () => {
    app = await startTestServer();
  });
  after(() => app.close());

  test("GET /live is 200 and touches no dependency", async () => {
    const { response, body } = await app.json("/live");
    assert.equal(response.status, 200);
    assert.equal(body.alive, true);
    assert.equal(body.phase, "ready");
    assert.ok(body.dependencies === undefined, "liveness must not report dependencies");
  });

  test("GET /ready is 200 and lists dependencies", async () => {
    const { response, body } = await app.json("/ready");
    assert.equal(response.status, 200);
    assert.equal(body.ready, true);
    assert.deepEqual(body.dependencies.map((d) => d.name), ["mongodb", "cache"]);
  });

  test("GET /ready is never cached", async () => {
    const response = await app.get("/ready");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("GET /health reports ok with dependency detail", async () => {
    const { response, body } = await app.json("/health");
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.alive, true);
    assert.equal(body.dependencies.length, 2);
  });

  test("GET /version reports build identity", async () => {
    const { response, body } = await app.json("/version");
    assert.equal(response.status, 200);
    assert.equal(body.version, "1.2.3");
    assert.equal(body.commit, "abc1234");
    assert.ok(body.runtime.startsWith("node "));
  });

  test("the same endpoints are served under /api, as documented", async () => {
    for (const path of ["/live", "/ready", "/health", "/version"]) {
      const response = await app.get(`/api${path}`);
      assert.equal(response.status, 200, `/api${path}`);
    }
  });

  test("a trailing slash resolves to the same probe", async () => {
    assert.equal((await app.get("/live/")).status, 200);
  });

  test("does not advertise the framework", async () => {
    assert.equal((await app.get("/live")).headers.get("x-powered-by"), null);
  });
});

describe("health endpoints — degraded and unavailable", () => {
  test("a failed critical dependency makes the instance unready but still alive", async () => {
    const app = await startTestServer({
      probes: [fakeProbe({ name: "mongodb", critical: true, ok: false })],
    });
    try {
      const ready = await app.json("/ready");
      assert.equal(ready.response.status, 503);
      assert.equal(ready.body.ready, false);
      assert.match(ready.body.reason, /mongodb/);

      // The distinction that prevents a database blip from restarting the fleet.
      const live = await app.json("/live");
      assert.equal(live.response.status, 200);
      assert.equal(live.body.alive, true);
    } finally {
      await app.close();
    }
  });

  test("a failed non-critical dependency stays ready and reports degraded", async () => {
    const app = await startTestServer({
      probes: [
        fakeProbe({ name: "mongodb", critical: true, ok: true }),
        fakeProbe({ name: "redis", critical: false, ok: false }),
      ],
    });
    try {
      const { response, body } = await app.json("/ready");
      assert.equal(response.status, 200, "Redis down must not remove the instance from rotation");
      assert.match(body.reason, /degraded: redis/);

      const health = await app.json("/health");
      assert.equal(health.body.status, "degraded");
    } finally {
      await app.close();
    }
  });

  test("a draining instance is unready but alive", async () => {
    const state = new ServiceState(Date.now());
    state.markReady();
    state.markDraining();
    const app = await startTestServer({ state });
    try {
      const ready = await app.json("/ready");
      assert.equal(ready.response.status, 503);
      assert.equal(ready.body.reason, "shutting down");
      assert.equal((await app.get("/live")).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe("correlation identifiers", () => {
  let app;
  before(async () => {
    app = await startTestServer();
  });
  after(() => app.close());

  test("generates and returns identifiers when none are supplied", async () => {
    const response = await app.get("/live");
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId, "X-Request-Id must always be returned");
    assert.equal(response.headers.get("x-trace-id"), requestId);
    assert.match(requestId, /^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID");
  });

  test("echoes a supplied request id", async () => {
    const response = await app.get("/live", { headers: { "X-Request-Id": "req-abc-123" } });
    assert.equal(response.headers.get("x-request-id"), "req-abc-123");
  });

  test("propagates a supplied correlation id as the trace id", async () => {
    const response = await app.get("/live", { headers: { "X-Correlation-Id": "corr-9" } });
    assert.equal(response.headers.get("x-correlation-id"), "corr-9");
    assert.equal(response.headers.get("x-trace-id"), "corr-9");
  });

  test("joins an existing W3C trace", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const response = await app.get("/live", {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    assert.equal(response.headers.get("x-trace-id"), traceId);
  });

  test("ignores a malformed traceparent instead of trusting it", async () => {
    const response = await app.get("/live", { headers: { traceparent: "garbage" } });
    assert.match(response.headers.get("x-trace-id"), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("rejects an injection attempt in an id header", async () => {
    // An unvalidated header echoed into a response is header injection, and
    // written to a log it lets a caller forge log lines.
    const response = await app.get("/live", {
      headers: { "X-Request-Id": "abc def<script>" },
    });
    const returned = response.headers.get("x-request-id");
    assert.ok(!returned.includes("<script>"));
    assert.match(returned, /^[0-9A-HJKMNP-TV-Z]{26}$/, "falls back to a generated id");
  });

  test("gives each request a distinct id", async () => {
    const [a, b] = await Promise.all([app.get("/live"), app.get("/live")]);
    assert.notEqual(a.headers.get("x-request-id"), b.headers.get("x-request-id"));
  });

  test("attaches the trace id to the log line for that request", async () => {
    await app.get("/live", { headers: { "X-Request-Id": "log-corr-1" } });
    const line = app.logger.find("request.completed").find((l) => l.requestId === "log-corr-1");
    assert.ok(line, "the completion log must carry the request id");
    assert.equal(line.route, "/live");
    assert.equal(line.status, 200);
  });
});

describe("error handling", () => {
  let app;
  before(async () => {
    app = await startTestServer();
  });
  after(() => app.close());

  test("an unknown route returns the standard error envelope", async () => {
    const { response, body } = await app.json("/does-not-exist");
    assert.equal(response.status, 404);
    assert.equal(body.error.kind, "not_found");
    assert.ok(body.error.message);
    assert.equal(body.error.field, null);
    assert.ok(body.error.traceId, "traceId must be present on every error");
  });

  test("the error trace id matches the response header, so it is actionable", async () => {
    const response = await fetch(`${app.base}/nope`);
    const body = await response.json();
    assert.equal(body.error.traceId, response.headers.get("x-trace-id"));
  });

  test("does not reflect the requested path into the response", async () => {
    const { body } = await app.json("/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.ok(!JSON.stringify(body).includes("script"));
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const { response, body } = await app.json("/api/v1/admin/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
    assert.equal(body.error.kind, "validation");
  });

  test("an oversized body is a 413", async () => {
    const app2 = await startTestServer({ config: { http: { ...app.config.http, bodyLimit: "100b" } } });
    try {
      const { response, body } = await app2.json("/api/v1/admin/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(500) }),
      });
      assert.equal(response.status, 413);
      assert.equal(body.error.kind, "payload_too_large");
    } finally {
      await app2.close();
    }
  });
});

describe("metrics endpoint", () => {
  test("exposes Prometheus text and counts requests by route", async () => {
    const app = await startTestServer();
    try {
      await app.get("/live");
      await app.get("/live");
      await app.get("/missing");

      const response = await app.get("/api/v1/admin/metrics");
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").includes("text/plain"));
      assert.match(text, /nova_requests_total\{[^}]*route="\/live"[^}]*status="2xx"[^}]*\} 2/);
      assert.match(text, /route="unmatched"[^}]*status="4xx"/);
      assert.ok(text.includes("nova_request_duration_seconds_bucket"));
    } finally {
      await app.close();
    }
  });

  test("counts errors by kind", async () => {
    const app = await startTestServer();
    try {
      await app.get("/missing");
      const text = await (await app.get("/api/v1/admin/metrics")).text();
      assert.match(text, /nova_request_errors_total\{[^}]*kind="not_found"[^}]*\} 1/);
    } finally {
      await app.close();
    }
  });

  test("is absent entirely when metrics are disabled", async () => {
    const app = await startTestServer({
      config: { metrics: { enabled: false, path: "/api/v1/admin/metrics", defaultLabels: {} } },
    });
    try {
      // Not mounted at all: an endpoint that exists but refuses is a scrape
      // target that alerts on itself.
      const { response, body } = await app.json("/api/v1/admin/metrics");
      assert.equal(response.status, 404);
      assert.equal(body.error.kind, "not_found");
    } finally {
      await app.close();
    }
  });
});
