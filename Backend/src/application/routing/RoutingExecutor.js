import { RetryDecision, SwitchPolicy } from "../../domain/routing/RetryPolicy.js";
import { FailureKind } from "../../domain/errors/ProviderError.js";
import { nullTracer } from "../../infrastructure/telemetry/Tracer.js";
import { AppError, ErrorKind, CancelledError } from "../../domain/errors/index.js";

/**
 * Carries out a routing decision.
 *
 * The effectful half of the router. The policy decided *what* to try and in
 * what order; this walks that chain, records every outcome, consults the retry
 * policy after each failure, and reports what happened.
 *
 * It is application layer, not infrastructure, because it is **orchestration**:
 * a defined sequence with defined failure semantics, using ports it does not
 * own. The genuinely infrastructural part — deadlines, abort signals, latency
 * measurement — lives in `ProviderInvoker` below it
 * (docs/backend/02-architecture.md#why-the-application-layer-exists-at-all).
 *
 * It contains **no ranking logic and no provider names**. Both would be a leak:
 * ranking belongs to the pure policy, and provider specifics belong in adapters.
 */
export class RoutingExecutor {
  /**
   * @param {object} deps
   * @param {import("../../domain/routing/RetryPolicy.js").RetryPolicy} deps.retryPolicy
   * @param {import("../../infrastructure/routing/ProviderInvoker.js").ProviderInvoker} deps.invoker
   * @param {import("../../infrastructure/providers/registry/ProviderRegistry.js").ProviderRegistry} deps.registry
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} deps.logger
   * @param {import("../../domain/ports/MetricsPort.js").MetricsPort} deps.metrics
   * @param {number} [deps.overallTimeoutMs] budget across every attempt
   */
  constructor({ retryPolicy, invoker, registry, clock, logger, metrics, usageRecorder, tracer = nullTracer, overallTimeoutMs = 120_000 }) {
    this.retryPolicy = retryPolicy;
    this.invoker = invoker;
    this.registry = registry;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "routing" }) ?? logger;
    this.metrics = metrics;
    this.usageRecorder = usageRecorder;
    this.tracer = tracer;
    this.overallTimeoutMs = overallTimeoutMs;
  }

  /**
   * @param {object} input
   * @param {import("../../domain/routing/RoutingDecision.js").RoutingDecision} input.decision
   * @param {(provider, model, options) => Promise<unknown>} input.invoke
   * @param {object} [input.options]
   * @param {string} [input.switchPolicy]
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<{result, model, provider, attempts, switched, latencyMs}>}
   */
  async execute({
    decision,
    invoke,
    options = {},
    switchPolicy = SwitchPolicy.AUTO,
    signal,
    // Providers this request is calling with the *user's* own key.
    userKeyProviders = new Set(),
  }) {
    const deadline = this.clock.now() + this.overallTimeoutMs;
    const attempts = [];
    const tried = [];
    let switched = null;
    let candidateIndex = 0;
    let retriesOnCurrent = 0;
    let lastError = null;

    while (candidateIndex < decision.chain.length) {
      const model = decision.chain[candidateIndex];
      const provider = this.registry.get(model.provider);

      if (!provider) {
        // The provider was unregistered between the snapshot and now. Not an
        // error — move to the next candidate.
        this.logger?.warn("routing.candidate_vanished", { provider: model.provider });
        candidateIndex += 1;
        continue;
      }

      // The overall budget bounds retries and failovers *in aggregate*, so
      // three slow attempts cannot add up past what a user will wait
      // (docs/backend/04-router.md#timeout-handling).
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        lastError = new AppError("The request took too long.", ErrorKind.TIMEOUT, {
          details: { attempts: attempts.length },
        });
        break;
      }

      if (!tried.includes(model.provider)) tried.push(model.provider);

      const outcome = await this.tracer.span(
        "provider.invoke",
        async (span) => {
          const run = await this.invoker.run({
            provider,
            model,
            invoke,
            options,
            signal,
            timeoutMs: Math.min(this.invoker.attemptTimeoutMs, remaining),
          });
          span?.setAttributes({
            "provider.outcome": run.ok ? "success" : "failure",
            "provider.failure_kind": run.error?.failureKind ?? null,
            "provider.latency_ms": run.latencyMs,
          });
          return run;
        },
        {
          "provider.id": model.provider,
          "provider.model": model.id,
          // 1-based, so it reads the way an operator counts attempts.
          "provider.attempt": attempts.length + 1,
        }
      );

      attempts.push({
        provider: model.provider,
        model: model.id,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        kind: outcome.error?.failureKind ?? null,
      });

      this.metrics.observe(
        "nova_provider_attempt_duration_seconds",
        outcome.latencyMs / 1000,
        { provider: model.provider, outcome: outcome.ok ? "success" : "failure" }
      );
      this.metrics.increment("nova_provider_attempts_total", {
        provider: model.provider,
        model: model.id,
        outcome: outcome.ok ? "success" : "failure",
      });

      // One accounting record per attempt, including the ones that failed.
      // They consumed real quota, and excluding them understates consumption
      // exactly where the waste lives
      // (docs/backend/11-observability.md#cost-monitoring).
      this.usageRecorder?.record({
        provider: model.provider,
        model: model.id,
        attempt: attempts.length,
        outcome: usageOutcome(outcome),
        failureKind: outcome.error?.failureKind ?? null,
        streaming: false,
        usage: outcome.result?.usage ?? null,
        latencyMs: outcome.latencyMs,
      });

      /* ---------------------------- success ---------------------------- */
      if (outcome.ok) {
        this.registry.recordSuccess(model.provider, outcome.latencyMs);
        return {
          result: outcome.result,
          model,
          provider: model.provider,
          attempts,
          switched,
          latencyMs: outcome.latencyMs,
        };
      }

      lastError = outcome.error;

      /* -------------------------- cancellation -------------------------- */
      // Never recorded as a provider failure. The provider did nothing wrong,
      // and counting it would open a breaker on a healthy provider — so a user
      // who cancels three generations would take it out for everyone.
      if (outcome.error instanceof CancelledError || outcome.error?.cancelled) {
        throw outcome.error;
      }

      // **A user's bad key must never open the shared breaker.**
      //
      // Easy to miss and severe when missed: one user pastes an expired key,
      // the breaker opens on `auth`, and every *other* user loses that provider
      // — for a credential that was never the platform's
      // (docs/backend/10-security.md#rules-for-user-supplied-keys).
      //
      // Only auth-shaped failures are exempted. A timeout or an outage on a
      // user's key is still the provider being unwell, and the fleet should
      // learn from it.
      const isUserKeyAuthFailure =
        userKeyProviders.has(model.provider) && outcome.error?.failureKind === FailureKind.AUTH;

      if (isUserKeyAuthFailure) {
        this.logger?.warn("routing.user_key_rejected", {
          provider: model.provider,
          detail: "not counted against the shared breaker",
        });
      } else {
        this.registry.recordFailure(model.provider, outcome.error);
      }

      /* ---------------------------- decide ------------------------------ */
      const hasAlternative = candidateIndex + 1 < decision.chain.length;
      const next = this.retryPolicy.next({
        error: outcome.error,
        attemptsUsed: attempts.length,
        retriesOnCurrent,
        hasAlternative,
        switchPolicy,
        cancelled: signal?.aborted === true,
        remainingBudgetMs: deadline - this.clock.now(),
      });

      if (next.action === RetryDecision.RETRY) {
        retriesOnCurrent += 1;
        this.metrics.increment("nova_routing_retries_total", {
          provider: model.provider,
          kind: outcome.error.failureKind,
        });
        this.logger?.info("routing.retry", {
          provider: model.provider,
          kind: outcome.error.failureKind,
          attempt: retriesOnCurrent,
          delayMs: next.delayMs,
          why: next.why,
        });
        if (next.delayMs > 0) await this.clock.sleep(next.delayMs, signal);
        continue; // same candidate
      }

      if (next.action === RetryDecision.FAILOVER) {
        const to = decision.chain[candidateIndex + 1];
        switched = {
          from: model,
          to,
          reason: outcome.error.failureKind,
          message: `${model.displayName} ${phraseFor(outcome.error.failureKind)}. Switched to ${to.displayName}.`,
        };
        // Marked on the root span so the tail sampler keeps this trace at
        // 100%. A failover that succeeded carries no error, so nothing else
        // would distinguish it from an ordinary request — and it is one of the
        // most informative traces the system produces.
        this.tracer.active()?.setAttributes({ "routing.switched": true });
        this.metrics.increment("nova_routing_failovers_total", {
          from: model.provider,
          to: to.provider,
          reason: outcome.error.failureKind,
        });
        this.logger?.warn("routing.failover", {
          from: model.provider,
          to: to.provider,
          kind: outcome.error.failureKind,
          why: next.why,
        });
        candidateIndex += 1;
        retriesOnCurrent = 0;
        continue;
      }

      if (next.action === RetryDecision.ASK) {
        // Not a switch. The user asked to be consulted, so the proposal is
        // surfaced and the request stops here.
        const proposal = outcome.error;
        proposal.requiresConfirmation = true;
        proposal.suggestion = decision.chain[candidateIndex + 1] ?? null;
        throw proposal;
      }

      break; // SURFACE
    }

    /* ---------------------------- exhausted ----------------------------- */
    this.metrics.increment("nova_routing_exhausted_total", {
      reason: lastError?.failureKind ?? lastError?.kind ?? "unknown",
    });
    this.logger?.warn("routing.attempts_exhausted", {
      tried,
      attempts: attempts.map((a) => ({ provider: a.provider, kind: a.kind })),
      lastKind: lastError?.failureKind ?? lastError?.kind,
    });

    throw this.#exhaustedError(lastError, attempts, tried);
  }

  /**
   * The terminal error, listing every provider tried and why each failed.
   *
   * One message with the full diagnostic, rather than only the last failure —
   * "all three providers failed" is actionable, "Groq timed out" hides that two
   * others were also attempted.
   */
  #exhaustedError(lastError, attempts, tried) {
    if (!lastError) {
      return new AppError("No provider attempt was made.", ErrorKind.PROVIDER_UNAVAILABLE);
    }
    // A single failed attempt surfaces its own error unchanged: wrapping it
    // would replace a specific, correct message with a vaguer one.
    if (attempts.length <= 1) return lastError;

    lastError.details = {
      ...(lastError.details ?? {}),
      attempts: attempts.map((a) => ({ provider: a.provider, kind: a.kind })),
      tried,
    };
    return lastError;
  }
}

/** Wording for the user-facing switch notice. Failover is never silent. */
function phraseFor(kind) {
  return (
    {
      quota: "reached its quota",
      rate_limit: "hit its rate limit",
      timeout: "timed out",
      outage: "is unavailable",
      auth: "rejected our credentials",
      api_error: "returned an error",
    }[kind] ?? "failed"
  );
}

/**
 * A cancelled attempt is not a failed one.
 *
 * The provider did nothing wrong, and lumping the two together would make
 * "wasted spend" read as provider unreliability — which points tuning at the
 * retry policy when the real cause is users closing tabs.
 */
function usageOutcome(outcome) {
  if (outcome.ok) return "success";
  if (outcome.error?.cancelled || outcome.error?.name === "CancelledError") return "cancelled";
  return "failure";
}
