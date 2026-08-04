import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Metrics } from "../../src/infrastructure/telemetry/Metrics.js";
import { recordingLogger } from "../helpers/testDoubles.js";

/**
 * The metric catalogue must cover everything the code actually emits.
 *
 * This is not a style check. `Metrics` drops an undeclared metric and logs a
 * warning, which is the right runtime behaviour — a telemetry defect must not
 * break the request it was measuring — but it means an undeclared metric
 * *silently does not exist*. Seven of them did, including `nova_stream_ttft_seconds`,
 * the metric the observability document calls the one that matters most for
 * perceived speed. Nothing failed. The dashboards would simply have been empty,
 * and the first person to notice would have been someone debugging an incident
 * with the panel they needed showing "No data".
 *
 * A static scan is the right shape for this: it catches the mistake at the
 * moment it is made, rather than requiring a test that happens to exercise the
 * code path where the metric is emitted.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

async function sourceFiles(dir = SRC, found = [], extensions = [".js"]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(path, found, extensions);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(path);
  }
  return found;
}

/** Every `nova_*` string literal outside the catalogue itself. */
async function emittedNames() {
  const names = new Map(); // name -> files
  for (const file of await sourceFiles()) {
    if (file.endsWith("telemetry/Metrics.js")) continue;
    const source = await readFile(file, "utf8");
    for (const [, name] of source.matchAll(/"(nova_[a-z0-9_]+)"/g)) {
      // Not a metric: the refresh cookie's name happens to share the prefix.
      if (name === "nova_refresh") continue;
      names.set(name, [...(names.get(name) ?? []), file.replace(SRC, "")]);
    }
  }
  return names;
}

const declared = () => new Set(new Metrics({ collectDefaults: false }).metrics.keys());

describe("metric catalogue", () => {
  test("every emitted metric is declared", async () => {
    const known = declared();
    const missing = [...(await emittedNames())]
      .filter(([name]) => !known.has(name))
      .map(([name, files]) => `${name} (emitted from ${files.join(", ")})`);

    assert.deepEqual(missing, [], "undeclared metrics are dropped, not reported");
  });

  test("every declared metric is emitted somewhere", async () => {
    // The other direction, and it is worth enforcing too: a declaration nobody
    // writes to exports a permanent zero, which reads on a dashboard exactly
    // like a system that is idle rather than one that is not instrumented.
    const emitted = new Set((await emittedNames()).keys());
    const orphans = [...declared()].filter((name) => !emitted.has(name));

    assert.deepEqual(orphans, [], "a metric nobody emits is a panel that always reads zero");
  });

  test("no metric carries an unbounded label", async () => {
    // Each distinct combination is a time series. A user-id label across a
    // five-metric set with 10,000 users is 50,000 series, which is how a
    // metrics bill outgrows a compute bill
    // (docs/backend/11-observability.md#cardinality-discipline).
    const forbidden = ["user", "userid", "user_id", "thread", "threadid", "thread_id", "traceid", "trace_id", "email", "ip"];
    const offenders = [];

    for (const [name, entry] of new Metrics({ collectDefaults: false }).metrics) {
      for (const label of entry.labels) {
        if (forbidden.includes(label.toLowerCase())) offenders.push(`${name}.${label}`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  test("every metric an alert or dashboard queries exists", async () => {
    // The same defect class as the one this file was written for, one layer
    // out: a rule that queries a metric nobody emits never fires, and a panel
    // that queries one reads "No data" — which looks exactly like a system that
    // is idle. Neither fails anything until an incident.
    const known = declared();
    const opsDir = new URL("../../../ops/", import.meta.url).pathname;

    const referenced = new Set();
    for (const file of await sourceFiles(opsDir, [], [".yml", ".json"])) {
      const text = await readFile(file, "utf8");
      for (const [, name] of text.matchAll(/(nova_[a-z0-9_]+)/g)) {
        // Histograms are queried through the derived series Prometheus
        // generates, which are not declared names of their own.
        referenced.add(name.replace(/_(bucket|sum|count)$/, ""));
      }
    }

    assert.ok(referenced.size > 10, "the ops directory should reference plenty of metrics");
    const missing = [...referenced].filter((name) => !known.has(name));
    assert.deepEqual(missing, [], "an alert or panel queries a metric that does not exist");
  });

  test("an undeclared metric is dropped and reported, never thrown", async () => {
    const logger = recordingLogger("warn");
    const metrics = new Metrics({ collectDefaults: false, logger });

    assert.doesNotThrow(() => metrics.increment("nova_not_a_real_metric", { a: 1 }));
    assert.equal(logger.find("metrics.unknown_metric").length, 1);
  });
});
