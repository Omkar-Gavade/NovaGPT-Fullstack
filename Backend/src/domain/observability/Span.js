/**
 * One timed operation, with a parent.
 *
 * Spans exist to answer a question a log line cannot: *where did the time go,
 * and in what order?* A 4.2-second request is only actionable once you can see
 * that 4,050 ms of it was the provider generating — because then no amount of
 * backend optimisation helps and the only lever is routing
 * (docs/backend/11-observability.md#tracing).
 *
 * Attributes MUST be low-cardinality identifiers. A model id is fine; a prompt
 * is not — for privacy, and because high-cardinality attributes make a tracing
 * backend both expensive and slow.
 */

export const SpanStatus = {
  UNSET: "unset",
  OK: "ok",
  ERROR: "error",
};

export class Span {
  /**
   * @param {object} raw
   * @param {string} raw.name        stable dotted name, e.g. `provider.invoke`
   * @param {string} raw.spanId
   * @param {string} raw.traceId
   * @param {string|null} [raw.parentSpanId]
   * @param {number} raw.startedAt   epoch milliseconds
   */
  constructor({ name, spanId, traceId, parentSpanId = null, startedAt, attributes = {} }) {
    this.name = name;
    this.spanId = spanId;
    this.traceId = traceId;
    this.parentSpanId = parentSpanId;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.status = SpanStatus.UNSET;
    this.attributes = { ...attributes };
    /** @type {{at: number, name: string, attributes: object}[]} */
    this.events = [];
  }

  get durationMs() {
    return this.endedAt === null ? null : this.endedAt - this.startedAt;
  }

  get isRoot() {
    return this.parentSpanId === null;
  }

  get failed() {
    return this.status === SpanStatus.ERROR;
  }

  setAttributes(attributes = {}) {
    Object.assign(this.attributes, attributes);
    return this;
  }

  /**
   * A point in time inside a span.
   *
   * Used for the moment of first token, which is a *point*, not a duration —
   * modelling it as a child span would imply the token generation stopped there.
   */
  addEvent(name, attributes = {}, at) {
    this.events.push({ name, attributes, at });
    return this;
  }

  end(at, { status = SpanStatus.OK, error = null } = {}) {
    if (this.endedAt !== null) return this; // ending twice would rewrite history
    this.endedAt = at;
    this.status = status;
    if (error) {
      // The kind and the message, never the cause chain: `cause` is where
      // upstream response bodies and connection strings live
      // (docs/backend/10-security.md#structural-defences-against-leakage-t1).
      this.attributes["error.kind"] = error.kind ?? error.failureKind ?? error.name ?? "error";
      this.attributes["error.message"] = error.message ?? String(error);
    }
    return this;
  }

  toJSON() {
    return {
      name: this.name,
      spanId: this.spanId,
      traceId: this.traceId,
      parentSpanId: this.parentSpanId,
      startedAt: this.startedAt,
      durationMs: this.durationMs,
      status: this.status,
      attributes: this.attributes,
      events: this.events.length ? this.events : undefined,
    };
  }
}
