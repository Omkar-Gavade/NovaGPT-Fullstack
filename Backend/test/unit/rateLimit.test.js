import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimitRule } from "../../src/domain/security/RateLimitRule.js";
import { RateLimiter, buildRules } from "../../src/application/security/RateLimiter.js";
import { InMemoryCache } from "../../src/infrastructure/cache/memory/InMemoryCache.js";
import { recordingMetrics, recordingLogger } from "../helpers/testDoubles.js";

/**
 * The policy is arithmetic and the counting is I/O, which is why the thresholds
 * below are assertable without a Redis.
 */

describe("RateLimitRule", () => {
  const rule = new RateLimitRule({ name: "test", limit: 10, windowMs: 60_000 });

  test("permits up to the limit", () => {
    assert.equal(rule.evaluate({ current: 10, previous: 0, now: 0 }).allowed, true);
    assert.equal(rule.evaluate({ current: 11, previous: 0, now: 0 }).allowed, false);
  });

  test("carries the previous window in, weighted by overlap", () => {
    // The point of a sliding window. At the very start of a window the previous
    // one counts in full, so a caller cannot spend a full quota at 11:59:59 and
    // another at 12:00:00.
    assert.equal(rule.evaluate({ current: 1, previous: 10, now: 0 }).allowed, false);
    // Halfway through, only half of it still counts.
    assert.equal(rule.evaluate({ current: 4, previous: 10, now: 30_000 }).allowed, true);
  });

  test("reports the rest of the window as the retry delay", () => {
    const decision = rule.evaluate({ current: 99, previous: 0, now: 15_000 });
    assert.equal(decision.retryAfterMs, 45_000);
    assert.equal(decision.retryAfterSeconds, 45);
  });

  test("a refusal never reports a zero-second retry", () => {
    // A `Retry-After: 0` produces a client that retries into the same refusal.
    const decision = rule.evaluate({ current: 99, previous: 0, now: 59_999 });
    assert.ok(decision.retryAfterSeconds >= 1);
  });

  test("fails open or closed as the rule declares", () => {
    const chat = new RateLimitRule({ name: "chat", limit: 5, windowMs: 1000 });
    const auth = new RateLimitRule({ name: "auth", limit: 5, windowMs: 1000, failClosed: true });

    // Refusing all chat to protect a quota is a self-inflicted outage worse
    // than the abuse it prevents; refusing logins for a few minutes is not.
    assert.equal(chat.onCounterUnavailable().allowed, true);
    assert.equal(auth.onCounterUnavailable().allowed, false);
    assert.equal(auth.onCounterUnavailable().degraded, true);
  });

  test("refuses a nonsensical rule at construction", () => {
    assert.throws(() => new RateLimitRule({ name: "x", limit: 0, windowMs: 1000 }), TypeError);
    assert.throws(() => new RateLimitRule({ name: "x", limit: 5, windowMs: 0 }), TypeError);
  });
});

describe("RateLimiter", () => {
  const build = ({ cache } = {}) => {
    let now = 1_000_000;
    const clock = { now: () => now, advance: (ms) => (now += ms) };
    const limiter = new RateLimiter({
      cache: cache ?? new InMemoryCache({ clock }),
      clock,
      metrics: recordingMetrics(),
      logger: recordingLogger("silent"),
    });
    return { limiter, clock };
  };

  test("counts and then refuses", async () => {
    const { limiter } = build();
    const rule = new RateLimitRule({ name: "r", limit: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await limiter.check(rule, "alice")).allowed, true, `hit ${i}`);
    }
    assert.equal((await limiter.check(rule, "alice")).allowed, false);
  });

  test("counts each subject separately", async () => {
    const { limiter } = build();
    const rule = new RateLimitRule({ name: "r", limit: 1, windowMs: 60_000 });

    assert.equal((await limiter.check(rule, "alice")).allowed, true);
    assert.equal((await limiter.check(rule, "alice")).allowed, false);
    // One noisy caller must not throttle everyone else.
    assert.equal((await limiter.check(rule, "bob")).allowed, true);
  });

  test("the window rolls over", async () => {
    const { limiter, clock } = build();
    const rule = new RateLimitRule({ name: "r", limit: 1, windowMs: 60_000 });

    await limiter.check(rule, "alice");
    assert.equal((await limiter.check(rule, "alice")).allowed, false);

    clock.advance(120_000);
    assert.equal((await limiter.check(rule, "alice")).allowed, true);
  });

  test("an unavailable counter follows the rule's failure mode, not a guess", async () => {
    // The cache reports `null`, which is not "zero" — whether an uncountable
    // request is permitted is a policy decision the rule owns.
    const broken = {
      async increment() {
        return null;
      },
      async get() {
        return null;
      },
    };
    const { limiter } = build({ cache: broken });

    const chat = new RateLimitRule({ name: "chat", limit: 1, windowMs: 1000 });
    const auth = new RateLimitRule({ name: "auth", limit: 1, windowMs: 1000, failClosed: true });

    assert.equal((await limiter.check(chat, "alice")).allowed, true);
    assert.equal((await limiter.check(auth, "1.2.3.4")).allowed, false);
  });

  test("checkAll stops at the first refusal", async () => {
    const { limiter } = build();
    const tight = new RateLimitRule({ name: "tight", limit: 1, windowMs: 60_000 });
    const loose = new RateLimitRule({ name: "loose", limit: 100, windowMs: 60_000 });

    await limiter.checkAll([{ rule: tight, subject: "a" }, { rule: loose, subject: "a" }]);
    const second = await limiter.checkAll([
      { rule: tight, subject: "a" },
      { rule: loose, subject: "a" },
    ]);

    assert.equal(second.rule, "tight");
    // The looser rule must not be charged for a request the tighter one
    // refused: the request never ran.
    const loosened = await limiter.check(loose, "a");
    assert.equal(loosened.remaining, 98);
  });
});

describe("buildRules", () => {
  test("auth fails closed and chat fails open", () => {
    const rules = buildRules({
      anonymousPerMinute: 30,
      authPerMinute: 10,
      chatPerMinute: 20,
      chatPerHour: 300,
    });

    assert.equal(rules.auth.failClosed, true);
    assert.equal(rules.chatMinute.failClosed, false);
    assert.equal(rules.chatHour.windowMs, 3_600_000);
  });
});
