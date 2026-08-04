import { StreamEventType, isTerminal } from "./StreamEvent.js";

/**
 * The state of one streaming attempt.
 *
 * Pure. It records what has been emitted, enforces the protocol invariants, and
 * answers the one question the retry policy needs: **has content already
 * reached the client?**
 *
 * That question is the whole reason this type exists. A stream that has emitted
 * deltas can never be retried in place — the client already has those tokens,
 * and replaying them would duplicate content
 * (docs/backend/07-streaming-engine.md#failover-mid-stream). Tracking it in a
 * mutable boolean scattered through the executor is how that rule gets violated
 * during a refactor.
 *
 * **One session per attempt.** A failover creates a new one, which is what
 * makes the buffer reset structural rather than a step someone must remember.
 */
export class StreamSession {
  constructor({ model, provider, attempt = 0 }) {
    this.model = model;
    this.provider = provider;
    this.attempt = attempt;

    this.buffer = [];
    this.deltaCount = 0;
    this.reasoningCount = 0;
    this.toolCalls = [];
    this.usage = null;
    this.finishReason = null;
    this.terminated = false;
    this.startedEmitted = false;
  }

  /** Content emitted so far in this attempt. */
  get content() {
    return this.buffer.join("");
  }

  get isEmpty() {
    return this.deltaCount === 0;
  }

  /**
   * Has anything reached the client?
   *
   * The retry policy reads this. Once true, same-provider retry is forbidden and
   * only failover (with a full restart) or surfacing the error remain.
   */
  get hasEmittedContent() {
    return this.deltaCount > 0 || this.reasoningCount > 0;
  }

  /**
   * Record an event, returning whether it should be forwarded.
   *
   * Filtering here rather than at each adapter means a normalisation rule is
   * enforced once for every provider that will ever exist.
   */
  accept(event) {
    if (this.terminated) return false;

    switch (event?.type) {
      case StreamEventType.START:
        // Providers can be chatty; a second `start` is a bug in an adapter and
        // must not reach the client, which would reset its rendering.
        if (this.startedEmitted) return false;
        this.startedEmitted = true;
        return true;

      case StreamEventType.DELTA:
        // Empty deltas are keep-alives. Forwarding them creates client-side
        // no-op renders and pollutes token accounting.
        if (!event.text) return false;
        this.buffer.push(event.text);
        this.deltaCount += 1;
        return true;

      case StreamEventType.REASONING:
        if (!event.text) return false;
        this.reasoningCount += 1;
        return true;

      case StreamEventType.TOOL_CALL:
        this.toolCalls.push(event);
        return true;

      case StreamEventType.USAGE:
        this.usage = {
          promptTokens: event.promptTokens ?? null,
          completionTokens: event.completionTokens ?? null,
        };
        return true;

      case StreamEventType.DONE:
      case StreamEventType.ERROR:
        this.terminated = true;
        this.finishReason = event.finishReason ?? null;
        return true;

      default:
        // Unknown event types are dropped rather than forwarded: a client that
        // receives a type it cannot parse is worse off than one that never
        // sees it, and forwarding would let an adapter bypass normalisation.
        return false;
    }
  }

  /** Reset for a fresh attempt against a new provider. */
  restart({ model, provider }) {
    return new StreamSession({ model, provider, attempt: this.attempt + 1 });
  }

  diagnostics() {
    return {
      model: this.model?.id ?? null,
      provider: this.provider ?? null,
      attempt: this.attempt,
      deltas: this.deltaCount,
      reasoningDeltas: this.reasoningCount,
      characters: this.content.length,
      toolCalls: this.toolCalls.length,
      usage: this.usage,
      finishReason: this.finishReason,
      terminated: this.terminated,
    };
  }
}

export { isTerminal };
