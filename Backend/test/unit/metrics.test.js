import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Metrics, nullMetrics } from "../../src/infrastructure/telemetry/Metrics.js";
import { recordingLogger } from "../helpers/testDoubles.js";

function build() {
  return new Metrics({ collectDefaults: false, logger: recordingLogger() });
}

describe("Metrics", () => {
  test("exports declared metrics before they ever fire", async () => {
    // A metric that only appears after the first failure is invisible on a
    // dashboard until something goes wrong.
    const output = await build().render();
    assert.ok(output.includes("nova_requests_total"));
    assert.ok(output.includes("nova_request_duration_seconds"));
    assert.ok(output.includes("nova_dependency_up"));
  });

  test("records a counter with its declared labels", async () => {
    const metrics = build();
    metrics.increment("nova_requests_total", { route: "/health", method: "GET", status: "2xx" });
    const output = await metrics.render();
    assert.match(output, /nova_requests_total\{[^}]*route="\/health"[^}]*\} 1/);
  });

  test("drops an undeclared label instead of creating a new series", async () => {
    const logger = recordingLogger();
    const metrics = new Metrics({ collectDefaults: false, logger });
    metrics.increment("nova_requests_total", {
      route: "/x",
      method: "GET",
      status: "2xx",
      userId: "u_12345",
    });
    const output = await metrics.render();
    assert.ok(!output.includes("u_12345"), "unbounded label must never reach the registry");
    assert.equal(logger.find("metrics.label_rejected").length, 1);
  });

  test("normalises a missing label rather than minting a distinct series", async () => {
    const metrics = build();
    metrics.increment("nova_requests_total", { route: "/x" });
    assert.match(await metrics.render(), /method="unknown"/);
  });

  test("warns and continues on an unknown metric name", () => {
    const logger = recordingLogger();
    const metrics = new Metrics({ collectDefaults: false, logger });
    assert.doesNotThrow(() => metrics.increment("nova_typo_total", {}));
    assert.equal(logger.find("metrics.unknown_metric").length, 1);
  });

  test("observes histograms and sets gauges", async () => {
    const metrics = build();
    metrics.observe("nova_request_duration_seconds", 0.42, { route: "/x", method: "GET" });
    metrics.setGauge("nova_dependency_up", 0, { dependency: "redis" });
    const output = await metrics.render();
    assert.ok(output.includes("nova_request_duration_seconds_bucket"));
    assert.match(output, /nova_dependency_up\{dependency="redis"\} 0/);
  });

  test("applies default labels to everything", async () => {
    const metrics = new Metrics({
      collectDefaults: false,
      defaultLabels: { region: "eu-west-1" },
      logger: recordingLogger(),
    });
    metrics.increment("nova_requests_total", { route: "/x", method: "GET", status: "2xx" });
    assert.match(await metrics.render(), /region="eu-west-1"/);
  });

  test("advertises the Prometheus content type", () => {
    assert.ok(build().contentType().includes("text/plain"));
  });
});

describe("nullMetrics", () => {
  test("satisfies the port so callers need no conditional", async () => {
    assert.doesNotThrow(() => nullMetrics.increment("anything", { a: 1 }));
    assert.doesNotThrow(() => nullMetrics.observe("anything", 1));
    assert.doesNotThrow(() => nullMetrics.setGauge("anything", 1));
    assert.equal(await nullMetrics.render(), "");
  });
});
