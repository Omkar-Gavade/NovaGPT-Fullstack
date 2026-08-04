import { StreamEventType, isTerminal } from "../../domain/streaming/StreamEvent.js";

/**
 * Writes `StreamEvent`s to an HTTP response as Server-Sent Events.
 *
 * The transport half of streaming, and the layer where most "streaming doesn't
 * work in production" bugs live. Each header and rule below is one of them
 * (docs/backend/07-streaming-engine.md#headers-and-why-each-is-required):
 *
 *   - `no-transform` stops proxies and CDNs buffering or compressing the
 *     stream, which otherwise delivers everything at the end and defeats the
 *     entire feature while looking like a slow backend.
 *   - `X-Accel-Buffering: no` is the nginx-specific form of the same thing;
 *     nginx buffers proxied responses by default.
 *   - Headers are **flushed before the first token**, or Node holds them until
 *     the first body write and a slow first token is indistinguishable from a
 *     broken connection.
 *   - Backpressure is respected: `res.write()` returning false means the socket
 *     buffer is full, and continuing to write grows server memory per stream.
 *   - Keep-alive pings every 15s, because proxies and mobile networks close
 *     idle connections at 30–60s and a model thinking for 40s would have its
 *     connection killed by infrastructure.
 */

/** Comfortably inside every common proxy idle timeout. */
const KEEPALIVE_MS = 15_000;

/**
 * Beyond this the consumer is not reading and memory is the only thing growing.
 * One such client is harmless; a thousand is an out-of-memory kill that takes
 * every other stream on the instance with it.
 */
const MAX_BUFFERED_BYTES = 1_000_000;

export class SseWriter {
  /**
   * @param {import("node:http").ServerResponse} res
   * @param {object} [deps]
   * @param {import("../../domain/ports/LoggerPort.js").LoggerPort} [deps.logger]
   */
  constructor(res, { logger } = {}) {
    this.res = res;
    this.logger = logger;
    this.open = false;
    this.keepAlive = null;
    this.bytesWritten = 0;
  }

  /** Send headers and flush. Must happen before the first event. */
  start() {
    if (this.open) return this;

    this.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-cache, no-transform");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.flushHeaders?.();

    this.open = true;
    this.keepAlive = setInterval(() => this.#ping(), KEEPALIVE_MS);
    this.keepAlive.unref?.();

    return this;
  }

  /**
   * Write one event, awaiting drain when the socket is full.
   *
   * @returns {Promise<boolean>} false when the client has gone away
   */
  async write(event) {
    if (!this.open || this.res.writableEnded) return false;

    const frame = `data: ${JSON.stringify(event)}\n\n`;
    this.bytesWritten += Buffer.byteLength(frame);

    // Both conditions matter: a large *and* backed-up stream is a consumer
    // that has stopped reading without disconnecting — a suspended tab, a
    // wedged proxy. A large stream that is draining fine is just a long answer.
    if (this.bytesWritten > MAX_BUFFERED_BYTES && this.res.writableNeedDrain) {
      // Converts an availability incident into one failed request.
      this.logger?.warn("sse.overflow", { bytesWritten: this.bytesWritten });
      this.end();
      return false;
    }

    const flushed = this.res.write(frame);
    if (!flushed) {
      // The consumer's pace now sets ours, which is what propagates
      // backpressure all the way back to the provider's socket.
      await once(this.res, "drain");
    }
    return true;
  }

  /**
   * Write a whole event stream, stopping cleanly if the client disconnects.
   *
   * @param {AsyncIterable<object>} events
   */
  async pipe(events) {
    let sawTerminal = false;
    for await (const event of events) {
      const delivered = await this.write(event);
      if (isTerminal(event)) sawTerminal = true;
      // The client is gone. Returning here lets the generator's `finally` run,
      // which releases the provider's reader rather than leaking a socket.
      if (!delivered) return { sawTerminal, aborted: true };
    }
    return { sawTerminal, aborted: false };
  }

  /**
   * A terminal event always ends the stream.
   *
   * A client that receives neither `done` nor `error` is left with a spinner it
   * can never resolve, so a caller that finished without one gets this.
   */
  async writeTerminalIfMissing(kind, message) {
    await this.write({ type: StreamEventType.ERROR, kind, message });
  }

  end() {
    if (!this.open) return;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.open = false;
    if (!this.res.writableEnded) this.res.end();
  }

  /**
   * SSE comment frame. Ignored by clients at zero parsing cost, and enough to
   * keep an idle connection alive.
   */
  #ping() {
    if (!this.open || this.res.writableEnded) return;
    this.res.write(": ping\n\n");
  }
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
