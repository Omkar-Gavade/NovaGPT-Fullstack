import { FailureKind } from "../errors/ProviderError.js";

/**
 * Retry and failover, as pure decisions.
 *
 * Retry and failover are different mechanisms for different failures and are
 * routinely conflated (docs/backend/04-router.md#retry):
 *
 *   **Retry** targets the *same* provider, for a transient blip. Cheap,
 *   invisible to the user, often sufficient.
 *   **Failover** targets a *different* provider, for provider-level
 *   unavailability. Expensive, and always visible to the user.
 *
 * Order matters: retry first, fail over only when the same provider keeps
 * failing. Inverting it abandons providers over single blips and causes needless
 * model churn.
 *
 * This class decides *whether* and *how long*; it never sleeps. The waiting is
 * the executor's job, which keeps every decision here testable without a timer.
 */

const RETRYABLE = new Set([FailureKind.TIMEOUT, FailureKind.RATE_LIMIT, FailureKind.OUTAGE]);

export const RetryDecision = {
  RETRY: "retry",
  FAILOVER: "failover",
  SURFACE: "surface",
  ASK: "ask",
};

export class RetryPolicy {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetriesPerProvider] retries *after* the first try
   * @param {number} [options.maxAttempts]  total provider attempts, all providers
   * @param {number} [options.baseDelayMs]
   * @param {number} [options.maxDelayMs]
   * @param {() => number} [options.random] injected so jitter is testable
   */
  constructor({
    maxRetriesPerProvider = 2,
    maxAttempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 4000,
    random = Math.random,
  } = {}) {
    this.maxRetriesPerProvider = maxRetriesPerProvider;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.random = random;
  }

  /** Would a second try against the *same* provider plausibly succeed? */
  isRetryable(error) {
    return RETRYABLE.has(kindOf(error));
  }

  /**
   * Would a *different* provider plausibly succeed?
   *
   * `api_error` is excluded and that exclusion is the most important rule here:
   * it means the *request* was rejected, so failing over multiplies one error
   * into N — plus latency, plus N wasted quota units.
   */
  isFailoverWorthy(error) {
    const kind = kindOf(error);
    return kind !== FailureKind.API_ERROR && kind !== undefined;
  }

  /**
   * What to do after a failed attempt.
   *
   * @param {object} state
   * @param {Error} state.error
   * @param {number} state.attemptsUsed        provider attempts consumed so far
   * @param {number} state.retriesOnCurrent    retries already spent on this provider
   * @param {boolean} state.hasAlternative     is another candidate available?
   * @param {string} state.switchPolicy        auto | ask | never
   * @param {boolean} [state.cancelled]
   * @param {boolean} [state.contentAlreadySent] a stream has emitted deltas
   * @param {number} [state.remainingBudgetMs] time left in the overall budget
   * @returns {{ action: string, delayMs: number, why: string }}
   */
  next(state) {
    const {
      error,
      attemptsUsed,
      retriesOnCurrent,
      hasAlternative,
      switchPolicy = SwitchPolicy.AUTO,
      cancelled = false,
      contentAlreadySent = false,
      remainingBudgetMs = Infinity,
    } = state;

    // The user stopped. Trying anything else spends quota on a request that was
    // explicitly abandoned (docs/backend/04-router.md, decision 14).
    if (cancelled) {
      return decision(RetryDecision.SURFACE, 0, "request cancelled");
    }

    // An UnsupportedCapabilityError here means the capability matrix claimed
    // something false. Masking it with a failover would hide a data bug that
    // keeps misrouting forever, so it must be loud.
    if (error?.name === "UnsupportedCapabilityError") {
      return decision(RetryDecision.SURFACE, 0, "capability matrix is wrong — must not be masked");
    }

    // Same-provider retry: cheapest option, and invisible to the user.
    // Forbidden once a stream has emitted deltas — the client already has those
    // tokens and replaying them would duplicate content.
    //
    // **A rate limit with an alternative available is not retried here.** The
    // other retryable kinds are blips: an immediate second attempt often works
    // and costs nothing. A rate limit is different in kind — the provider has
    // stated it will refuse us for a specific period — so retrying spends the
    // attempt budget on a refusal we were promised, and makes the user wait out
    // the backoff while an idle provider sits unused. Chaos exercise 5 is
    // exactly this scenario, and it is the one that validates the
    // multi-provider premise (docs/backend/12-testing.md#chaos-exercises).
    const shouldWaitHereAnyway = !(kindOf(error) === FailureKind.RATE_LIMIT && hasAlternative);

    // **One attempt is reserved for somewhere else, whenever there is a
    // somewhere else.**
    //
    // Without this, the defaults make failover unreachable: with
    // `maxAttempts: 3` and `maxRetriesPerProvider: 2`, a provider that fails
    // consistently takes attempts 1, 2 and 3 — and the request surfaces
    // "attempt budget exhausted" having never tried the healthy provider
    // sitting idle beside it. The fleet's entire premise is that one provider
    // going down is a non-event, and it was not.
    //
    // Found by the vision failover test in Phase 12, which is the first test to
    // script a provider that fails *every* attempt rather than one.
    const budgetForThisProvider = hasAlternative ? this.maxAttempts - 1 : this.maxAttempts;

    const canRetryHere =
      this.isRetryable(error) &&
      shouldWaitHereAnyway &&
      retriesOnCurrent < this.maxRetriesPerProvider &&
      attemptsUsed < budgetForThisProvider &&
      !contentAlreadySent;

    if (canRetryHere) {
      const delayMs = this.delayFor(retriesOnCurrent, error);
      // A provider asking us to wait longer than the request has left is a
      // reason to go elsewhere, not to wait and then fail anyway. Clipping the
      // wait instead would retry early and risk turning a rate limit into a ban.
      if (delayMs < remainingBudgetMs) {
        return decision(
          RetryDecision.RETRY,
          delayMs,
          `${kindOf(error)} is transient; retrying the same provider`
        );
      }
    }

    if (!this.isFailoverWorthy(error)) {
      return decision(
        RetryDecision.SURFACE,
        0,
        "the request itself was rejected; another provider would fail identically"
      );
    }

    if (switchPolicy === SwitchPolicy.NEVER) {
      return decision(RetryDecision.SURFACE, 0, "switchPolicy=never");
    }

    if (!hasAlternative) {
      return decision(RetryDecision.SURFACE, 0, "no alternative provider is available");
    }

    if (attemptsUsed >= this.maxAttempts) {
      return decision(RetryDecision.SURFACE, 0, "attempt budget exhausted");
    }

    if (switchPolicy === SwitchPolicy.ASK) {
      return decision(RetryDecision.ASK, 0, "switchPolicy=ask; awaiting confirmation");
    }

    return decision(RetryDecision.FAILOVER, 0, `${kindOf(error)}; switching provider`);
  }

  /**
   * Backoff before a same-provider retry.
   *
   * Exponential with **full jitter**. Without jitter, every client that failed
   * together retries together, producing a synchronised thundering herd that
   * recreates the overload the backoff was meant to relieve.
   *
   * A server-supplied `Retry-After` overrides the heuristic entirely and is
   * **not** clipped by `maxDelayMs`. That cap bounds our own guesswork; the
   * provider is stating a fact, and shortening the wait it asked for is how a
   * rate limit becomes a ban. A `Retry-After` longer than the request can
   * afford is handled by `next()`, which fails over rather than waiting.
   */
  delayFor(retriesOnCurrent, error) {
    if (Number.isFinite(error?.retryAfter) && error.retryAfter > 0) {
      return error.retryAfter * 1000;
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** retriesOnCurrent);
    return Math.floor(this.random() * ceiling);
  }
}

export const SwitchPolicy = Object.freeze({
  /** Switch, then tell the user. Availability beats model identity for most requests. */
  AUTO: "auto",
  /** Surface the proposal and wait. For users comparing models. */
  ASK: "ask",
  /** Report the error; never switch. For reproducibility-critical work. */
  NEVER: "never",
});

export const isSwitchPolicy = (value) => Object.values(SwitchPolicy).includes(value);

function kindOf(error) {
  return error?.failureKind;
}

function decision(action, delayMs, why) {
  return { action, delayMs, why };
}
