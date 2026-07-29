import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { routeLabel, statusClass } from "../../src/interfaces/http/routeLabel.js";

describe("routeLabel", () => {
  test("uses the matched pattern, never the concrete URL", () => {
    // The whole point: /threads/:id is one series, not one per thread.
    assert.equal(
      routeLabel({ route: { path: "/:threadId" }, baseUrl: "/api/v1/threads" }),
      "/api/v1/threads/:threadId"
    );
  });

  test("collapses unmatched requests to a single label", () => {
    // A scanner probing random URLs would otherwise mint a time series per
    // probe — a cardinality attack requiring no authentication.
    assert.equal(routeLabel({ originalUrl: "/random/9f2b/x" }), "unmatched");
  });

  test("handles a root-mounted route", () => {
    assert.equal(routeLabel({ route: { path: "/" }, baseUrl: "" }), "/");
    assert.equal(routeLabel({ route: { path: "/live" }, baseUrl: "" }), "/live");
  });
});

describe("statusClass", () => {
  test("collapses a status to its class", () => {
    assert.equal(statusClass(200), "2xx");
    assert.equal(statusClass(404), "4xx");
    assert.equal(statusClass(503), "5xx");
  });

  test("guards against a nonsense status", () => {
    assert.equal(statusClass(undefined), "unknown");
    assert.equal(statusClass(99), "unknown");
  });
});
