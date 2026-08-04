import { CancelledError } from "../../domain/errors/index.js";

/**
 * In-flight streams, so a client can stop one.
 *
 * `POST /chat/stop` arrives on a **different HTTP connection** from the stream
 * it cancels, so the abort signal cannot be reached through the original
 * request object. Something has to hold the link between a stream id and its
 * `AbortController`, and this is it.
 *
 * **Per-instance, deliberately, and this is a real limitation.** With more than
 * one server instance a stop request may land on a process that is not running
 * the stream, and the stop silently does nothing. The correct fix is a Redis
 * pub/sub channel keyed by stream id — the same shared-state argument that makes
 * Redis a prerequisite for horizontal scaling
 * (docs/backend/15-decisions.md#adr-014--redis-is-required-for-horizontal-scaling).
 * Recorded here rather than solved, because a single instance is the current
 * deployment and pretending otherwise would be worse than saying so.
 *
 * Entries are also self-expiring: a stream whose process died mid-flight would
 * otherwise leak a controller for the life of the process.
 */
export class StreamRegistry {
  /**
   * @param {object} deps
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {number} [deps.maxAgeMs] beyond this an entry is presumed dead
   */
  constructor({ clock, metrics, maxAgeMs = 10 * 60_000 } = {}) {
    this.clock = clock;
    this.metrics = metrics;
    this.maxAgeMs = maxAgeMs;
    /** @type {Map<string, {controller: AbortController, threadId: string, startedAt: number, ownerId: string|null}>} */
    this.streams = new Map();
  }

  /**
   * @returns {AbortController} the controller the stream must respect
   */
  register(streamId, { threadId, ownerId = null, signal } = {}) {
    this.#sweep();

    const controller = new AbortController();
    // Chained so a client disconnect (the transport's own signal) still aborts
    // the stream, independently of an explicit stop call.
    signal?.addEventListener("abort", () => controller.abort(new CancelledError()), { once: true });

    this.streams.set(streamId, {
      controller,
      threadId,
      ownerId,
      startedAt: this.clock.now(),
    });
    this.#report();
    return controller;
  }

  /**
   * Stop a stream.
   *
   * Owner-scoped: without the check, any caller who guessed a stream id could
   * cancel someone else's generation. Returns false for unknown *and* for
   * not-yours, so a caller cannot probe which ids exist.
   */
  stop(streamId, ownerId = null) {
    const entry = this.streams.get(streamId);
    if (!entry) return false;
    if (ownerId && entry.ownerId && entry.ownerId !== ownerId) return false;

    entry.controller.abort(new CancelledError());
    this.streams.delete(streamId);
    this.#report();
    return true;
  }

  release(streamId) {
    this.streams.delete(streamId);
    this.#report();
  }

  has(streamId) {
    return this.streams.has(streamId);
  }

  get size() {
    return this.streams.size;
  }

  /**
   * Wait for in-flight streams to finish, then abort whatever is left.
   *
   * A deploy that kills every live generation is a deploy that visibly breaks
   * conversations for whoever happened to be mid-answer. Most generations
   * finish in seconds, so waiting a few is nearly always enough — and the
   * budget is what stops one very long generation holding a rolling deploy open
   * indefinitely (docs/backend/13-deployment.md#graceful-shutdown).
   *
   * @param {number} budgetMs how long to wait before aborting the stragglers
   * @param {number} [pollMs]
   * @returns {Promise<{drained: number, aborted: number, waitedMs: number}>}
   */
  async drain(budgetMs, pollMs = 50) {
    const started = this.clock.now();
    const initial = this.streams.size;

    while (this.streams.size > 0 && this.clock.now() - started < budgetMs) {
      // Deliberately not unref'd: the wait must hold the event loop open, or
      // Node decides there is nothing left to do and exits mid-drain — which
      // is the exact bug the shutdown sequence was written to avoid.
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const aborted = this.streams.size;
    this.stopAll();
    return { drained: initial - aborted, aborted, waitedMs: this.clock.now() - started };
  }

  /** Stop everything, immediately. The end of `drain`, and the panic button. */
  stopAll() {
    for (const [id, entry] of this.streams) {
      entry.controller.abort(new CancelledError());
      this.streams.delete(id);
    }
    this.#report();
  }

  /**
   * Concurrency, as a gauge.
   *
   * Reported from here rather than counted at the call sites, because this map
   * is the only thing that knows the truth — a caller that forgets to decrement
   * produces a gauge that climbs forever and an autoscaler that believes it
   * (docs/backend/13-deployment.md#scaling).
   */
  #report() {
    this.metrics?.setGauge("nova_active_streams", this.streams.size);
  }

  #sweep() {
    const cutoff = this.clock.now() - this.maxAgeMs;
    for (const [id, entry] of this.streams) {
      if (entry.startedAt < cutoff) this.streams.delete(id);
    }
  }
}
