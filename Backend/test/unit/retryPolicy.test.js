import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy, RetryDecision, SwitchPolicy } from "../../src/domain/routing/RetryPolicy.js";
import { ProviderError, FailureKind, UnsupportedCapabilityError } from "../../src/domain/errors/index.js";

/**
 * Retry and failover are different mechanisms for different failures, and the
 * distinction is the thing most often got wrong. These tests pin it down.
 */

const err = (kind, options) => new ProviderError(`test ${kind}`, kind, options);
// Jitter is random by design; injecting the source makes delays assertable.
const policy = (options) => new RetryPolicy({ random: () => 1, ...options });

const state = (overrides = {}) => ({
  attemptsUsed: 1,
  retriesOnCurrent: 0,
  hasAlternative: true,
  switchPolicy: SwitchPolicy.AUTO,
  ...overrides,
});

describe("RetryPolicy — which failures are retryable", () => {
  test("transient kinds retry against the same provider", () => {
    for (const kind of [FailureKind.TIMEOUT, FailureKind.RATE_LIMIT, FailureKind.OUTAGE]) {
      assert.ok(policy().isRetryable(err(kind)), kind);
    }
  });

  test("facts about provider state are never retried", () => {
    // A quota error will not change in the next second; a second attempt is
    // guaranteed waste.
    for (const kind of [FailureKind.QUOTA, FailureKind.AUTH, FailureKind.API_ERROR]) {
      assert.ok(!policy().isRetryable(err(kind)), kind);
    }
  });
});

describe("RetryPolicy — which failures are worth another provider", () => {
  test("api_error never fails over", () => {
    // The request itself was rejected, so failing over multiplies one error
    // into N plus latency plus N wasted quota units.
    assert.ok(!policy().isFailoverWorthy(err(FailureKind.API_ERROR)));
  });

  test("every operational kind fails over, including auth", () => {
    for (const kind of [
      FailureKind.QUOTA,
      FailureKind.RATE_LIMIT,
      FailureKind.TIMEOUT,
      FailureKind.OUTAGE,
      FailureKind.AUTH,
    ]) {
      assert.ok(policy().isFailoverWorthy(err(kind)), kind);
    }
  });
});

describe("RetryPolicy — the decision after a failure", () => {
  test("retries the same provider first, before failing over", () => {
    // Retry is cheap and invisible; failover is expensive and user-visible.
    const next = policy().next(state({ error: err(FailureKind.TIMEOUT) }));
    assert.equal(next.action, RetryDecision.RETRY);
  });

  test("fails over once same-provider retries are spent", () => {
    const next = policy().next(
      state({ error: err(FailureKind.TIMEOUT), retriesOnCurrent: 2, attemptsUsed: 1 })
    );
    assert.equal(next.action, RetryDecision.FAILOVER);
  });

  test("fails over immediately on a non-retryable but failover-worthy kind", () => {
    const next = policy().next(state({ error: err(FailureKind.QUOTA) }));
    assert.equal(next.action, RetryDecision.FAILOVER);
  });

  test("surfaces an api_error rather than trying anything else", () => {
    const next = policy().next(state({ error: err(FailureKind.API_ERROR) }));
    assert.equal(next.action, RetryDecision.SURFACE);
    assert.match(next.why, /rejected/);
  });

  test("surfaces when no alternative exists", () => {
    const next = policy().next(state({ error: err(FailureKind.QUOTA), hasAlternative: false }));
    assert.equal(next.action, RetryDecision.SURFACE);
    assert.match(next.why, /no alternative/);
  });

  test("surfaces once the attempt budget is spent", () => {
    const next = policy().next(
      state({ error: err(FailureKind.QUOTA), attemptsUsed: 3 })
    );
    assert.equal(next.action, RetryDecision.SURFACE);
    assert.match(next.why, /budget exhausted/);
  });

  test("never switches under switchPolicy=never", () => {
    const next = policy().next(
      state({ error: err(FailureKind.QUOTA), switchPolicy: SwitchPolicy.NEVER })
    );
    assert.equal(next.action, RetryDecision.SURFACE);
  });

  test("asks for confirmation under switchPolicy=ask", () => {
    const next = policy().next(
      state({ error: err(FailureKind.QUOTA), switchPolicy: SwitchPolicy.ASK })
    );
    assert.equal(next.action, RetryDecision.ASK);
  });

  test("a cancelled request stops immediately", () => {
    // Trying anything else spends quota on a request explicitly abandoned.
    const next = policy().next(state({ error: err(FailureKind.TIMEOUT), cancelled: true }));
    assert.equal(next.action, RetryDecision.SURFACE);
    assert.match(next.why, /cancelled/);
  });

  test("an UnsupportedCapabilityError is surfaced, never masked by failover", () => {
    // It means the capability matrix claimed something false; hiding it would
    // let the data bug keep misrouting forever.
    const next = policy().next(state({ error: new UnsupportedCapabilityError("p", "vision") }));
    assert.equal(next.action, RetryDecision.SURFACE);
    assert.match(next.why, /capability matrix/);
  });

  test("a stream that already emitted content is never retried in place", () => {
    // The client has those tokens; replaying would duplicate content.
    const next = policy().next(
      state({ error: err(FailureKind.TIMEOUT), contentAlreadySent: true })
    );
    assert.equal(next.action, RetryDecision.FAILOVER);
  });
});

describe("RetryPolicy — backoff", () => {
  test("grows exponentially from the base delay", () => {
    const p = policy({ baseDelayMs: 100 });
    assert.equal(p.delayFor(0, err(FailureKind.TIMEOUT)), 100);
    assert.equal(p.delayFor(1, err(FailureKind.TIMEOUT)), 200);
    assert.equal(p.delayFor(2, err(FailureKind.TIMEOUT)), 400);
  });

  test("is capped", () => {
    const p = policy({ baseDelayMs: 300, maxDelayMs: 4000 });
    assert.equal(p.delayFor(10, err(FailureKind.TIMEOUT)), 4000);
  });

  test("applies full jitter", () => {
    // Without jitter, every client that failed together retries together and
    // recreates the overload the backoff was meant to relieve.
    const values = new Set();
    const p = new RetryPolicy({ baseDelayMs: 1000, random: Math.random });
    for (let i = 0; i < 40; i += 1) values.add(p.delayFor(2, err(FailureKind.TIMEOUT)));
    assert.ok(values.size > 20, "delays must be spread, not constant");
    assert.ok(Math.max(...values) <= 4000);
    assert.ok(Math.min(...values) >= 0);
  });

  test("Retry-After overrides the computed backoff", () => {
    // The provider knows better than our heuristic; ignoring it is how a rate
    // limit becomes a ban.
    const p = policy({ baseDelayMs: 100 });
    assert.equal(p.delayFor(0, err(FailureKind.RATE_LIMIT, { retryAfter: 3 })), 3000);
  });

  test("Retry-After is NOT clipped by the backoff cap", () => {
    // maxDelayMs bounds our own guesswork. The provider is stating a fact, and
    // shortening the wait it asked for is how a rate limit becomes a ban.
    const p = policy({ maxDelayMs: 4000 });
    assert.equal(p.delayFor(0, err(FailureKind.RATE_LIMIT, { retryAfter: 600 })), 600_000);
  });

  test("a Retry-After longer than the remaining budget fails over instead of waiting", () => {
    // Waiting then failing anyway is strictly worse than going elsewhere now.
    const next = policy().next(
      state({ error: err(FailureKind.RATE_LIMIT, { retryAfter: 300 }), remainingBudgetMs: 5000 })
    );
    assert.equal(next.action, RetryDecision.FAILOVER);
  });

  test("a retry decision carries its delay", () => {
    const next = policy({ baseDelayMs: 250 }).next(state({ error: err(FailureKind.TIMEOUT) }));
    assert.equal(next.action, RetryDecision.RETRY);
    assert.equal(next.delayMs, 250);
  });
});

describe("RetryPolicy — a rate limit with somewhere else to go", () => {
  // Chaos exercise 5, as a unit test. The router used to retry a rate-limited
  // provider twice before considering a failover, which spent the whole attempt
  // budget on a provider that had just said "not now" — and made the user wait
  // out two backoffs while an idle provider sat unused. Three attempts later
  // the request failed with 429 and never touched the healthy provider.
  const policy = new RetryPolicy({ maxRetriesPerProvider: 2, maxAttempts: 3 });

  const rateLimited = () =>
    new ProviderError("slow down", FailureKind.RATE_LIMIT, { provider: "saturated" });

  test("fails over immediately rather than waiting", () => {
    const next = policy.next({
      error: rateLimited(),
      attemptsUsed: 1,
      retriesOnCurrent: 0,
      hasAlternative: true,
      switchPolicy: SwitchPolicy.AUTO,
      remainingBudgetMs: 60_000,
    });

    assert.equal(next.action, RetryDecision.FAILOVER);
    assert.equal(next.delayMs, 0, "there is no reason to wait when an alternative is idle");
  });

  test("still retries in place when there is nowhere else to go", () => {
    // Waiting is the only option left, and the provider told us how long.
    const next = policy.next({
      error: rateLimited(),
      attemptsUsed: 1,
      retriesOnCurrent: 0,
      hasAlternative: false,
      switchPolicy: SwitchPolicy.AUTO,
      remainingBudgetMs: 60_000,
    });

    assert.equal(next.action, RetryDecision.RETRY);
  });

  test("a timeout still retries in place even with an alternative", () => {
    // The distinction is the point: a timeout is a blip, and an immediate
    // second attempt often works at no cost. A rate limit is a stated refusal.
    const next = policy.next({
      error: new ProviderError("slow", FailureKind.TIMEOUT, { provider: "p" }),
      attemptsUsed: 1,
      retriesOnCurrent: 0,
      hasAlternative: true,
      switchPolicy: SwitchPolicy.AUTO,
      remainingBudgetMs: 60_000,
    });

    assert.equal(next.action, RetryDecision.RETRY);
  });
});
