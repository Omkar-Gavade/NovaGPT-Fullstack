/**
 * Server-Sent Events parsing, shared by every HTTP adapter.
 *
 * Small, and carrying most of the bugs a streaming provider integration can
 * have. Each rule below is a defect that only appears under real network
 * conditions (docs/backend/07-streaming-engine.md#normalisation-rules-every-adapter-follows):
 *
 *   - **Partial frames are buffered.** TCP splits frames at arbitrary byte
 *     boundaries. A parser that treats each chunk as complete silently drops
 *     the split frame's content — words go missing, never reproducibly.
 *   - **Multiple frames per chunk are all parsed.** A fast provider packs
 *     several events into one read; taking only the first loses the rest.
 *   - **Malformed frames are skipped, not fatal.** One unparseable keep-alive
 *     or comment must not kill a working stream.
 *   - **Terminators never leak.** `[DONE]` is a wire artefact, not content.
 *   - **The reader is always released.** A `return` or `throw` inside the loop
 *     without cancelling leaks a socket per abandoned stream — invisible until
 *     connection exhaustion under load.
 *
 * Pure with respect to protocol: it yields `data:` payloads as strings and
 * knows nothing about what any provider puts inside them.
 */

/** The OpenAI-dialect terminator. Recognised, never emitted. */
export const SSE_TERMINATOR = "[DONE]";

/**
 * Parse a byte stream into `data:` payloads.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.terminator]
 * @returns {AsyncGenerator<string>}
 */
export async function* parseSseStream(body, { signal, terminator = SSE_TERMINATOR } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` keeps a multi-byte character split across chunk
      // boundaries intact; without it a UTF-8 sequence cut in half becomes a
      // replacement character in the middle of a word.
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Everything after the last
      // separator is an incomplete frame and stays in the buffer.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const payload = extractData(frame);
        if (payload === null) continue;
        if (payload === terminator) return;
        yield payload;
      }
    }

    // A stream that ends without a blank line still has a complete frame in the
    // buffer. Dropping it loses the last event — often the one carrying usage.
    const trailing = extractData(buffer);
    if (trailing !== null && trailing !== terminator) yield trailing;
  } finally {
    // Releases the upstream socket on every exit path: normal completion,
    // early return, abort, or a throw from the consumer.
    reader.cancel().catch(() => {});
  }
}

/**
 * Pull the `data:` payload out of one frame.
 *
 * A frame may carry several `data:` lines, which the spec says to join with
 * newlines. Comments (`:`) and other fields (`event:`, `id:`) are ignored
 * rather than treated as errors — providers use them for keep-alives.
 *
 * @returns {string|null} the payload, or null when the frame carries no data
 */
function extractData(frame) {
  if (!frame || !frame.trim()) return null;

  const parts = [];
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith(":")) continue; // comment / keep-alive
    if (!trimmed.startsWith("data:")) continue; // event:, id:, retry:
    parts.push(trimmed.slice(5).trimStart());
  }

  return parts.length ? parts.join("\n") : null;
}

/**
 * Parse a payload as JSON, or return null.
 *
 * Deliberately swallowing: a malformed frame must not kill a working stream, so
 * the caller skips it and continues.
 */
export function parseJsonPayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
