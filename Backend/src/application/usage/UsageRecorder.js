import { randomUUID } from "node:crypto";
import { UsageRecord, UsageOutcome } from "../../domain/usage/UsageRecord.js";
import { currentContext } from "../../infrastructure/telemetry/traceContext.js";

/**
 * Turns a finished provider attempt into an accounting fact.
 *
 * One place, so pricing, metric emission and the storage shape cannot drift
 * between the streaming and non-streaming paths — which they would, because
 * those two paths are written months apart and by whoever needed them.
 *
 * **Recording never fails a request.** Accounting is derivative: refusing a
 * user's answer because the spend row could not be written trades a reporting
 * gap for an outage. Failures are logged at `error`, which is what makes the
 * gap noticed rather than silent.
 *
 * Correlation comes from async local storage rather than from parameters. The
 * alternative is threading `traceId`, `userId` and `threadId` through every
 * executor signature — an observability concern in the type of every function
 * it passes through (docs/backend/11-observability.md#correlation).
 */
export class UsageRecorder {
  constructor({ usage, costTable, clock, logger, metrics }) {
    this.usage = usage;
    this.costTable = costTable;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "usage" }) ?? logger;
    this.metrics = metrics;
  }

  /**
   * @param {object} attempt
   * @param {string} attempt.provider
   * @param {string} [attempt.model]
   * @param {number} attempt.attempt        1-based
   * @param {"success"|"failure"|"cancelled"} attempt.outcome
   * @param {string|null} [attempt.failureKind]
   * @param {boolean} [attempt.streaming]
   * @param {{promptTokens?: number, completionTokens?: number}|null} [attempt.usage]
   * @param {number} [attempt.latencyMs]
   * @param {number|null} [attempt.ttftMs]
   */
  record(attempt) {
    const at = new Date(this.clock.now());
    const promptTokens = attempt.usage?.promptTokens ?? 0;
    const completionTokens = attempt.usage?.completionTokens ?? 0;

    const record = new UsageRecord({
      id: randomUUID(),
      ...correlation(),
      provider: attempt.provider,
      model: attempt.model ?? null,
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      failureKind: attempt.failureKind ?? null,
      streaming: attempt.streaming === true,
      promptTokens,
      completionTokens,
      // Priced at the moment it was incurred, so a later price change does not
      // retroactively rewrite what last month cost.
      costUsd: attempt.model
        ? this.costTable.costFor({
            modelId: attempt.model,
            promptTokens,
            completionTokens,
            at: at.toISOString(),
          })
        : null,
      latencyMs: attempt.latencyMs,
      ttftMs: attempt.ttftMs ?? null,
      at,
    });

    this.#emit(record);

    // Deliberately not awaited. The write is off the request's critical path,
    // and the `catch` is what keeps a storage blip from becoming an unhandled
    // rejection that takes the process down.
    Promise.resolve(this.usage?.record(record)).catch((error) =>
      this.logger?.error("usage.write_failed", {
        provider: record.provider,
        outcome: record.outcome,
        error,
      })
    );

    return record;
  }

  #emit(record) {
    const labels = { provider: record.provider, model: record.model ?? "unknown" };

    if (record.promptTokens) {
      this.metrics?.increment("nova_provider_tokens_total", { ...labels, direction: "prompt" }, record.promptTokens);
    }
    if (record.completionTokens) {
      this.metrics?.increment("nova_provider_tokens_total", { ...labels, direction: "completion" }, record.completionTokens);
    }
    // `null` means unpriced, and incrementing by null would silently record
    // nothing while looking like a zero-cost model.
    if (typeof record.costUsd === "number" && record.costUsd > 0) {
      this.metrics?.increment("nova_provider_cost_usd_total", labels, record.costUsd);
    }
    if (record.isWaste && record.totalTokens) {
      this.metrics?.increment(
        "nova_wasted_tokens_total",
        { provider: record.provider, reason: record.failureKind ?? record.outcome },
        record.totalTokens
      );
    }
  }
}

export { UsageOutcome };

/** Trace, user and thread ids from the ambient request context. */
function correlation() {
  const context = currentContext();
  return {
    traceId: context?.traceId ?? null,
    userId: context?.userId ?? null,
    threadId: context?.threadId ?? null,
  };
}
