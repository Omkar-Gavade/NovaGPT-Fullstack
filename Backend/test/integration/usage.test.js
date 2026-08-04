import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";
import { CostTable } from "../../src/infrastructure/providers/catalog/CostTable.js";
import { UsageRecorder } from "../../src/application/usage/UsageRecorder.js";
import { InMemoryUsageRepository } from "../../src/infrastructure/persistence/memory/InMemoryUsageRepository.js";
import { recordingMetrics, recordingLogger } from "../helpers/testDoubles.js";

/**
 * Cost accounting, from a real request through to a priced record.
 *
 * The interesting cases are all about what gets counted when something goes
 * *wrong*, because that is where a naive implementation quietly under-reports.
 */

describe("usage accounting", () => {
  test("a successful turn produces one priced record", async () => {
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "count me" });

      const records = await app.usage.list({});
      assert.equal(records.length, 1);

      const record = records[0];
      assert.equal(record.outcome, "success");
      assert.equal(record.attempt, 1);
      assert.equal(record.provider, "mock");
      assert.ok(record.latencyMs >= 0);
      // The correlation key: this record and its log lines share one id.
      assert.ok(record.traceId, "a record with no trace id cannot be joined to anything");
    } finally {
      await app.close();
    }
  });

  test("a failover leaves the whole story, in attempt order", async () => {
    // Three records sharing a trace id with ascending attempt numbers *are* the
    // failover story, queryable without touching logs.
    // A retryable kind, so the same provider is tried again and the second
    // attempt succeeds — two records, one request.
    const primary = buildMockProvider();
    primary.script([{ fail: "timeout" }]);
    const app = await startApp({ providers: [primary] });

    try {
      await app.post("/api/v1/chat", { message: "fail then work" });

      // Read *by trace id*, which is the query that exists for exactly this:
      // it sorts by attempt, so the story reads in the order it happened. An
      // unscoped list sorts newest-first, and two attempts a millisecond apart
      // then come back reversed — which is how this assertion first went
      // intermittently red.
      const { traceId } = (await app.usage.list({}))[0];
      const story = await app.usage.list({ traceId });

      assert.equal(story.length, 2, "the failed attempt must be recorded too");
      assert.deepEqual(
        story.map((r) => [r.attempt, r.outcome, r.failureKind]),
        [
          [1, "failure", "timeout"],
          [2, "success", null],
        ]
      );
    } finally {
      await app.close();
    }
  });

  test("a streaming turn records time to first token", async () => {
    const app = await startApp();
    try {
      await app.sse("/api/v1/chat/stream", { message: "stream me" });

      const [record] = await app.usage.list({});
      assert.equal(record.streaming, true);
      assert.ok(record.ttftMs !== null, "TTFT is the number users actually feel");
      assert.ok(record.ttftMs <= record.latencyMs);
    } finally {
      await app.close();
    }
  });

  test("the record carries the user it belongs to", async () => {
    const app = await startApp();
    try {
      const alice = await app.signIn("spender@novagpt.test");
      await app.post("/api/v1/chat", { message: "mine" }, { token: alice.token });

      const [record] = await app.usage.list({ userId: alice.user.id });
      assert.equal(record.userId, alice.user.id);

      const summary = await app.usage.summarise({ userId: alice.user.id });
      assert.equal(summary.attempts, 1);
    } finally {
      await app.close();
    }
  });
});

describe("UsageRecorder — pricing", () => {
  const build = () => {
    const usage = new InMemoryUsageRepository({ clock: { now: () => 1_000_000 } });
    const metrics = recordingMetrics();
    const costTable = new CostTable([
      { model: "paid-model", input: 1.0, output: 2.0, effectiveFrom: "2020-01-01" },
      { model: "free-model", input: 0, output: 0, effectiveFrom: "2020-01-01" },
    ]);
    const recorder = new UsageRecorder({
      usage,
      costTable,
      clock: { now: () => 1_700_000_000_000 },
      logger: recordingLogger("silent"),
      metrics,
    });
    return { recorder, usage, metrics };
  };

  test("prices from measured tokens, per million", () => {
    const { recorder } = build();
    const record = recorder.record({
      provider: "p",
      model: "paid-model",
      attempt: 1,
      outcome: "success",
      usage: { promptTokens: 1_000_000, completionTokens: 500_000 },
      latencyMs: 10,
    });

    // 1M in at $1 + 0.5M out at $2 = $2.00
    assert.equal(record.costUsd, 2);
  });

  test("free-tier tokens are counted even though the cost is zero", () => {
    // Free tiers have limits. Token consumption is the resource whether or not
    // it is billed.
    const { recorder, metrics } = build();
    const record = recorder.record({
      provider: "p",
      model: "free-model",
      attempt: 1,
      outcome: "success",
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    assert.equal(record.costUsd, 0);
    assert.equal(record.totalTokens, 150);
    const tokens = metrics.calls.increment.filter((c) => c.name === "nova_provider_tokens_total");
    assert.equal(tokens.length, 2, "prompt and completion are counted separately");
  });

  test("an unpriced model is null, never zero", () => {
    // Collapsing the two would silently understate spend every time a model is
    // added without a price.
    const { recorder, metrics } = build();
    const record = recorder.record({
      provider: "p",
      model: "brand-new-model",
      attempt: 1,
      outcome: "success",
      usage: { promptTokens: 10, completionTokens: 10 },
    });

    assert.equal(record.costUsd, null);
    assert.equal(
      metrics.calls.increment.filter((c) => c.name === "nova_provider_cost_usd_total").length,
      0,
      "an unknown price must not be reported as free"
    );
  });

  test("a failed attempt's tokens are counted as waste", () => {
    const { recorder, metrics } = build();
    recorder.record({
      provider: "p",
      model: "paid-model",
      attempt: 2,
      outcome: "failure",
      failureKind: "timeout",
      usage: { promptTokens: 900, completionTokens: 100 },
    });

    const wasted = metrics.calls.increment.find((c) => c.name === "nova_wasted_tokens_total");
    assert.equal(wasted.value, 1000);
    assert.equal(wasted.labels.reason, "timeout");
  });

  test("a cancelled attempt is waste, but not a provider failure", () => {
    // Lumping the two together makes "wasted spend" read as provider
    // unreliability, which points tuning at the retry policy when the real
    // cause is users closing tabs.
    const { recorder, metrics } = build();
    recorder.record({
      provider: "p",
      model: "paid-model",
      attempt: 1,
      outcome: "cancelled",
      usage: { promptTokens: 500, completionTokens: 0 },
    });

    const wasted = metrics.calls.increment.find((c) => c.name === "nova_wasted_tokens_total");
    assert.equal(wasted.labels.reason, "cancelled");
  });

  test("a storage failure is logged, never thrown at the caller", async () => {
    // Refusing a user's answer because the spend row could not be written
    // trades a reporting gap for an outage.
    const logger = recordingLogger("error");
    const recorder = new UsageRecorder({
      usage: {
        record: async () => {
          throw new Error("disk on fire");
        },
      },
      costTable: new CostTable([]),
      clock: { now: () => 1 },
      logger,
      metrics: recordingMetrics(),
    });

    assert.doesNotThrow(() =>
      recorder.record({ provider: "p", model: "m", attempt: 1, outcome: "success" })
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(logger.find("usage.write_failed").length, 1);
  });

  test("missing token counts are zero, so a spend column never becomes NaN", () => {
    const { recorder } = build();
    const record = recorder.record({
      provider: "p",
      model: "paid-model",
      attempt: 1,
      outcome: "failure",
      usage: null,
    });
    assert.equal(record.totalTokens, 0);
    assert.equal(record.costUsd, 0);
  });
});
