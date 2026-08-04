import {
  ProviderError,
  FailureKind,
  AppError,
  CancelledError,
  DeadlineError,
} from "../../domain/errors/index.js";

/**
 * Runs one provider attempt, with a timeout, cancellation, and measurement.
 *
 * This is the only place in the routing path that touches wall-clock deadlines
 * and abort signals, which is why it is infrastructure rather than application:
 * it is I/O mechanics, not orchestration. The executor above it decides *what*
 * to attempt and *whether* to try again; this decides nothing at all.
 *
 * Its three jobs:
 *
 *   1. **Bound the attempt.** A single provider attempt gets its own budget,
 *      smaller than the router's overall budget so there is room left to fail
 *      over (docs/backend/04-router.md#timeout-handling).
 *   2. **Normalise the failure.** Anything thrown becomes a `ProviderError`
 *      with a `failureKind`, because every retry and failover decision above is
 *      made from that taxonomy alone.
 *   3. **Measure.** Latency feeds the ranking, so it must be recorded on the
 *      attempt that produced it, including failures.
 */
export class ProviderInvoker {
  /**
   * @param {object} deps
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} [deps.logger]
   * @param {number} [deps.attemptTimeoutMs]
   */
  constructor({ clock, logger, attemptTimeoutMs = 60_000 }) {
    this.clock = clock;
    this.logger = logger;
    this.attemptTimeoutMs = attemptTimeoutMs;
  }

  /**
   * @param {object} input
   * @param {object} input.provider   a ProviderPort implementation
   * @param {import("../../domain/capability/ModelDescriptor.js").ModelDescriptor} input.model
   * @param {(provider, model, options) => Promise<unknown>} input.invoke
   * @param {object} [input.options]  generation options passed through
   * @param {AbortSignal} [input.signal] caller cancellation
   * @param {number} [input.timeoutMs] override for this attempt
   * @returns {Promise<{ok: boolean, result?: unknown, error?: ProviderError, latencyMs: number}>}
   *
   * Returns an outcome rather than throwing. The executor has to record a
   * failure, consult a policy, and possibly continue — expressing that as
   * try/catch around every call site invites a missed branch.
   */
  async run({ provider, model, invoke, options = {}, signal, timeoutMs }) {
    const started = this.clock.now();
    const budget = timeoutMs ?? this.attemptTimeoutMs;

    // Chained so the provider sees one signal that fires on either the caller's
    // cancellation or our deadline. Without linking, a timeout would abandon
    // the local await while the provider kept generating — burning the full
    // quota unit for output nobody reads.
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(new CancelledError());
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DeadlineError(budget));
    }, budget);

    try {
      if (signal?.aborted) throw new CancelledError();

      const result = await invoke(provider, model, {
        ...options,
        model: model.id,
        signal: controller.signal,
      });

      return { ok: true, result, latencyMs: this.clock.now() - started };
    } catch (raw) {
      const latencyMs = this.clock.now() - started;
      const error = this.#normalise(raw, { provider, timedOut, cancelled: signal?.aborted });

      this.logger?.debug("routing.attempt_failed", {
        provider: provider.id,
        model: model.id,
        kind: error.failureKind ?? "cancelled",
        latencyMs,
      });

      return { ok: false, error, latencyMs };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /**
   * Map anything thrown into the taxonomy.
   *
   * Cancellation is deliberately **not** a ProviderError. The provider did
   * nothing wrong, and recording it as a failure would open a breaker on a
   * healthy provider — so a user who cancels three long generations would take
   * that provider out of rotation for everyone.
   */
  #normalise(raw, { provider, timedOut, cancelled }) {
    if (cancelled || raw instanceof CancelledError || raw?.name === "AbortError") {
      // Only genuine caller cancellation; our own deadline is checked first
      // below so a timeout is never mistaken for a user pressing stop.
      if (!timedOut) return new CancelledError();
    }

    if (timedOut || raw instanceof DeadlineError) {
      return new ProviderError(`${provider.name} did not respond in time`, FailureKind.TIMEOUT, {
        provider: provider.id,
        cause: raw instanceof Error ? raw : undefined,
      });
    }

    if (ProviderError.is(raw)) return raw;

    // An adapter that lets a raw error escape is a contract violation. The
    // router still has to make a decision, so it is classified conservatively
    // as api_error — which does NOT trigger failover, because an unknown fault
    // is more likely ours than theirs.
    if (AppError.is(raw)) return raw;

    return new ProviderError(
      `${provider.name} failed unexpectedly`,
      FailureKind.API_ERROR,
      { provider: provider.id, cause: raw instanceof Error ? raw : new Error(String(raw)) }
    );
  }
}

export { CancelledError, DeadlineError };
