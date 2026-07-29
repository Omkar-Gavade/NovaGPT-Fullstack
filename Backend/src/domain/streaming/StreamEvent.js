/**
 * The normalised streaming event protocol — **types only**.
 *
 * The streaming *engine* (SSE transport, provider frame normalisation,
 * backpressure, mid-stream failover, cancellation) is Phase 3
 * (docs/backend/07-streaming-engine.md). What lives here is the vocabulary that
 * `ProviderPort.stream()` is typed against, because the provider interface
 * cannot be defined without naming what it yields.
 *
 * Defining the event type now rather than yielding plain strings is the point:
 * a raw string can only say "here is more text". It cannot carry usage, a tool
 * call, a reasoning trace, or a finish reason — all of which providers already
 * emit. Adapters written against strings would have to discard that
 * information or smuggle it through a side channel, and both are worse than
 * settling the type once.
 */

export const StreamEventType = {
  /** Stream established. Once. */
  START: "start",
  /** Incremental content. Many. */
  DELTA: "delta",
  /** Reasoning-trace content, rendered separately from the answer. */
  REASONING: "reasoning",
  /** The model requested a tool. */
  TOOL_CALL: "tool_call",
  /** Token accounting. Once, at the end, where the provider supplies it. */
  USAGE: "usage",
  /** Stream complete. Terminal. */
  DONE: "done",
  /** Terminal failure. Terminal. */
  ERROR: "error",
};

/**
 * Exactly one of these ends every stream — never both, never neither.
 * A client receiving neither is left with a spinner it can never resolve.
 */
export const TERMINAL_EVENTS = Object.freeze([StreamEventType.DONE, StreamEventType.ERROR]);

export const isTerminal = (event) => TERMINAL_EVENTS.includes(event?.type);

/* Constructors, so adapters cannot invent a differently-shaped event. */

export const startEvent = (model, provider) => ({
  type: StreamEventType.START,
  model,
  provider,
});

export const deltaEvent = (text) => ({ type: StreamEventType.DELTA, text });

export const reasoningEvent = (text) => ({ type: StreamEventType.REASONING, text });

export const toolCallEvent = (id, name, args) => ({
  type: StreamEventType.TOOL_CALL,
  id,
  name,
  arguments: args,
});

export const usageEvent = (usage) => ({ type: StreamEventType.USAGE, ...usage });

export const doneEvent = (model, provider, finishReason = "stop") => ({
  type: StreamEventType.DONE,
  model,
  provider,
  finishReason,
});

export const errorEvent = (kind, message) => ({
  type: StreamEventType.ERROR,
  kind,
  message,
});
