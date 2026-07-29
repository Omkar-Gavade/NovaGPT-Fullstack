import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProviderContract, TRANSPORT_CASES } from "./providerContract.js";
import { buildMockProvider } from "../helpers/mockProvider.js";
import { StreamEventType } from "../../src/domain/streaming/StreamEvent.js";

/**
 * The mock adapter is the first thing held to the contract.
 *
 * Running the suite against it proves the suite is *satisfiable* before any
 * real adapter is written. A contract nothing has ever passed is a guess about
 * what adapters can do, and it is usually wrong in the direction of being
 * impossible to meet.
 */

runProviderContract({
  name: "mock",
  create: () => buildMockProvider(),
  model: "mock-standard",
  scriptFailure: (provider, kind) => provider.script([{ fail: kind }]),
  scriptDelay: (provider, ms) => provider.script([{ delayMs: ms }]),
});

describe("mock provider — scripting", () => {
  test("follows the script attempt by attempt", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "quota" }, { fail: "timeout" }, { text: "third time lucky" }]);

    await assert.rejects(() => call(provider), (e) => e.failureKind === "quota");
    await assert.rejects(() => call(provider), (e) => e.failureKind === "timeout");
    assert.equal((await call(provider)).text, "third time lucky");
  });

  test("behaves steadily past the end of the script", async () => {
    // A test asserting "and then it keeps working" should not have to script
    // an unbounded number of successes.
    const provider = buildMockProvider();
    provider.script([{ fail: "outage" }]);
    await assert.rejects(() => call(provider));
    assert.equal((await call(provider)).text, "mock response");
    assert.equal((await call(provider)).text, "mock response");
  });

  test("records every call for assertion", async () => {
    const provider = buildMockProvider();
    await call(provider);
    await call(provider, "mock-vision");
    assert.deepEqual(
      provider.calls.map((c) => [c.method, c.model]),
      [["generate", "mock-standard"], ["generate", "mock-vision"]]
    );
  });

  test("reset clears script, attempts, and call log", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "quota" }]);
    await assert.rejects(() => call(provider));
    provider.reset();
    assert.equal(provider.calls.length, 0);
    assert.equal((await call(provider)).text, "mock response");
  });

  test("surfaces retryAfter, so backoff behaviour is testable", async () => {
    const provider = buildMockProvider();
    provider.script([{ fail: "rate_limit", retryAfter: 30 }]);
    await assert.rejects(() => call(provider), (error) => {
      assert.equal(error.retryAfter, 30);
      assert.deepEqual(error.details, { retryAfterSeconds: 30 });
      return true;
    });
  });

  test("can report itself unhealthy without failing calls", async () => {
    const provider = buildMockProvider();
    provider.script([{ unhealthy: true }]);
    const health = await provider.health();
    assert.equal(health.ok, false);
  });
});

describe("mock provider — streaming behaviours the router must handle", () => {
  test("produces an empty stream on demand", async () => {
    // Silent quota exhaustion often manifests as an empty 200. The router must
    // treat it as a failure, not render a blank reply — so it must be
    // reproducible without a network.
    const provider = buildMockProvider();
    provider.script([{ emptyStream: true }]);
    const events = await collect(provider.stream([{ role: "user", content: "x" }], { model: "mock-standard" }));
    assert.equal(events.filter((e) => e.type === StreamEventType.DELTA).length, 0);
    assert.equal(events.at(-1).type, StreamEventType.DONE);
  });

  test("fails after deltas have already reached the caller", async () => {
    // The hard failover case: the client has rendered output that a second
    // provider will not continue.
    const provider = buildMockProvider({ defaultText: "one two three four five" });
    provider.script([{ failAfterChunks: 2 }]);

    const seen = [];
    await assert.rejects(async () => {
      for await (const event of provider.stream([{ role: "user", content: "x" }], { model: "mock-standard" })) {
        seen.push(event);
      }
    }, (error) => error.failureKind === "outage");

    assert.equal(seen.filter((e) => e.type === StreamEventType.DELTA).length, 2);
  });

  test("reports usage before the terminal event", async () => {
    const provider = buildMockProvider();
    const events = await collect(provider.stream([{ role: "user", content: "hello" }], { model: "mock-standard" }));
    const usage = events.find((e) => e.type === StreamEventType.USAGE);
    assert.ok(usage, "usage is what cost accounting is computed from");
    assert.ok(usage.promptTokens > 0);
    assert.ok(events.indexOf(usage) < events.length - 1);
  });
});

describe("mock provider — capability enforcement", () => {
  test("refuses vision on the text-only model", async () => {
    const provider = buildMockProvider();
    await assert.rejects(
      () => provider.vision([{ url: "x" }], "describe", { model: "mock-standard" }),
      { name: "UnsupportedCapabilityError" }
    );
  });

  test("allows vision on the vision model", async () => {
    const provider = buildMockProvider();
    const result = await provider.vision([{ url: "x" }], "describe", { model: "mock-vision" });
    assert.match(result.text, /vision/);
  });

  test("embeddings are deterministic, so tests need no literal vectors", async () => {
    const provider = buildMockProvider();
    const [a] = await provider.embeddings(["hello"], { model: "mock-vision" });
    const [b] = await provider.embeddings(["hello"], { model: "mock-vision" });
    assert.deepEqual(a, b);
    assert.equal(a.length, 8);
  });

  test("provider capability union covers both models", async () => {
    const capabilities = buildMockProvider().capabilities();
    assert.ok(capabilities.supports("vision"), "from mock-vision");
    assert.ok(capabilities.supports("toolCalling"), "from mock-standard");
  });
});

describe("contract coverage", () => {
  test("records the transport cases deferred to Phase 3", () => {
    // Not a behavioural assertion — a tripwire. If this list is emptied or
    // deleted without the cases being implemented, the omission is visible in
    // a diff rather than lost.
    assert.ok(TRANSPORT_CASES.length >= 10);
    assert.ok(TRANSPORT_CASES.every((c) => typeof c === "string" && c.length > 0));
  });
});

const call = (provider, model = "mock-standard") =>
  provider.generate([{ role: "user", content: "hi" }], { model });

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
