import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StreamSession } from "../../src/domain/streaming/StreamSession.js";
import {
  StreamEventType,
  deltaEvent,
  startEvent,
  doneEvent,
  usageEvent,
  isTerminal,
} from "../../src/domain/streaming/StreamEvent.js";
import { parseSseStream, parseJsonPayload } from "../../src/infrastructure/providers/shared/SseParser.js";

/** A ReadableStream that emits exactly the chunks given, as bytes. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const collect = async (iterable) => {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
};

describe("SseParser — frame handling", () => {
  test("parses a simple stream", async () => {
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']))
    );
    assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  });

  test("buffers a frame split across chunks", async () => {
    // TCP splits frames at arbitrary byte boundaries. A parser treating each
    // chunk as complete silently drops the split frame — words go missing, and
    // never reproducibly.
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"hel', 'lo":"wor', 'ld"}\n\n']))
    );
    assert.deepEqual(payloads, ['{"hello":"world"}']);
  });

  test("parses multiple frames arriving in one chunk", async () => {
    // A fast provider packs several events into one read; taking only the first
    // loses the rest.
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n']))
    );
    assert.equal(payloads.length, 3);
  });

  test("skips comments and keep-alives without dying", async () => {
    const payloads = await collect(
      parseSseStream(streamOf([': keep-alive\n\n', 'data: {"a":1}\n\n', ':\n\n']))
    );
    assert.deepEqual(payloads, ['{"a":1}']);
  });

  test("ignores non-data fields", async () => {
    const payloads = await collect(
      parseSseStream(streamOf(['event: message\nid: 42\ndata: {"a":1}\n\n']))
    );
    assert.deepEqual(payloads, ['{"a":1}']);
  });

  test("never leaks the terminator as content", async () => {
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"a":1}\n\n', "data: [DONE]\n\n"]))
    );
    assert.deepEqual(payloads, ['{"a":1}'], "[DONE] is a wire artefact, not content");
  });

  test("stops reading after the terminator", async () => {
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"a":1}\n\n', "data: [DONE]\n\n", 'data: {"late":1}\n\n']))
    );
    assert.equal(payloads.length, 1);
  });

  test("emits a trailing frame that has no blank line", async () => {
    // Otherwise the last event is lost — often the one carrying usage.
    const payloads = await collect(parseSseStream(streamOf(['data: {"a":1}\n\ndata: {"last":1}'])));
    assert.deepEqual(payloads, ['{"a":1}', '{"last":1}']);
  });

  test("handles CRLF line endings", async () => {
    const payloads = await collect(parseSseStream(streamOf(['data: {"a":1}\r\n\r\n'])));
    assert.deepEqual(payloads, ['{"a":1}']);
  });

  test("keeps a multi-byte character split across chunks intact", async () => {
    // Without streaming decode, a UTF-8 sequence cut in half becomes a
    // replacement character in the middle of a word.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"t":"日本語"}\n\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 14));
        controller.enqueue(bytes.slice(14));
        controller.close();
      },
    });
    const [payload] = await collect(parseSseStream(stream));
    assert.equal(JSON.parse(payload).t, "日本語");
  });

  test("releases the reader when the consumer stops early", async () => {
    // A return inside the loop without cancelling leaks a socket per abandoned
    // stream — invisible until connection exhaustion under load.
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\ndata: {"b":2}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _ of parseSseStream(stream)) break; // eslint-disable-line no-unused-vars
    assert.equal(cancelled, true);
  });

  test("stops on an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const payloads = await collect(
      parseSseStream(streamOf(['data: {"a":1}\n\n']), { signal: controller.signal })
    );
    assert.equal(payloads.length, 0);
  });

  test("a malformed payload parses to null rather than throwing", () => {
    // One unparseable keep-alive must not kill a working stream.
    assert.equal(parseJsonPayload("{not json"), null);
    assert.deepEqual(parseJsonPayload('{"ok":1}'), { ok: 1 });
  });
});

describe("StreamSession — protocol enforcement", () => {
  const session = () => new StreamSession({ model: { id: "m" }, provider: "p" });

  test("drops empty deltas", () => {
    // Providers emit empty content frames as keep-alives; forwarding them
    // creates client-side no-op renders and pollutes token accounting.
    const s = session();
    assert.equal(s.accept(deltaEvent("")), false);
    assert.equal(s.accept(deltaEvent("hi")), true);
    assert.equal(s.deltaCount, 1);
  });

  test("drops a duplicate start", () => {
    const s = session();
    assert.equal(s.accept(startEvent("m", "p")), true);
    assert.equal(s.accept(startEvent("m", "p")), false);
  });

  test("drops unknown event types rather than forwarding them", () => {
    const s = session();
    assert.equal(s.accept({ type: "invented" }), false);
  });

  test("accumulates content in order", () => {
    const s = session();
    for (const word of ["The ", "capital ", "is Paris."]) s.accept(deltaEvent(word));
    assert.equal(s.content, "The capital is Paris.");
  });

  test("reports whether content has reached the client", () => {
    // The rule that prevents duplicated tokens: once true, same-provider retry
    // is forbidden.
    const s = session();
    assert.equal(s.hasEmittedContent, false);
    s.accept(deltaEvent("x"));
    assert.equal(s.hasEmittedContent, true);
  });

  test("an empty stream is detectable", () => {
    // Silent quota exhaustion often manifests as an empty 200.
    const s = session();
    s.accept(startEvent("m", "p"));
    s.accept(doneEvent("m", "p"));
    assert.equal(s.isEmpty, true);
  });

  test("captures usage for cost accounting", () => {
    const s = session();
    s.accept(usageEvent({ promptTokens: 100, completionTokens: 20 }));
    assert.deepEqual(s.usage, { promptTokens: 100, completionTokens: 20 });
  });

  test("nothing is accepted after a terminal event", () => {
    const s = session();
    s.accept(doneEvent("m", "p"));
    assert.equal(s.accept(deltaEvent("late")), false);
  });

  test("exactly one terminal event ends a stream", () => {
    assert.ok(isTerminal(doneEvent("m", "p")));
    assert.ok(!isTerminal(deltaEvent("x")));
  });

  test("restart yields a fresh session with an empty buffer", () => {
    // The buffer reset is structural: concatenating two attempts' output
    // produces "The capital of The capital of France is Paris."
    const s = session();
    s.accept(deltaEvent("partial output"));
    const next = s.restart({ model: { id: "m2" }, provider: "p2" });
    assert.equal(next.content, "");
    assert.equal(next.hasEmittedContent, false);
    assert.equal(next.attempt, 1);
  });

  test("diagnostics describe the attempt", () => {
    const s = session();
    s.accept(deltaEvent("hello"));
    const d = s.diagnostics();
    assert.equal(d.deltas, 1);
    assert.equal(d.characters, 5);
    assert.equal(d.provider, "p");
  });
});
