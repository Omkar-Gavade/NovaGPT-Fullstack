import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Thread, Message, Role, FinishReason } from "../../src/domain/conversation/Thread.js";
import { ConversationSettings } from "../../src/domain/conversation/ConversationSettings.js";
import { StreamRegistry } from "../../src/application/chat/StreamRegistry.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";
import { ErrorKind, CancelledError } from "../../src/domain/errors/index.js";

const msg = (role, content, extra = {}) =>
  new Message({ id: extra.id ?? `${role}-${content.slice(0, 6)}`, role, content, ...extra });

const threadWith = (messages = []) => new Thread({ id: "t1", messages });

describe("Message", () => {
  test("rejects an unknown role", () => {
    assert.throws(() => new Message({ role: "wizard", content: "x" }), /Unknown message role/);
  });

  test("requires content", () => {
    assert.throws(() => new Message({ role: "user" }), /needs content/);
  });

  test("records which model produced an assistant turn", () => {
    // With failover, different turns come from different providers; without
    // this a tone shift is inexplicable and undebuggable.
    const m = msg("assistant", "hi", { model: "m1", provider: "p1" });
    assert.equal(m.model, "m1");
    assert.equal(m.provider, "p1");
  });

  test("user turns carry no model", () => {
    assert.equal(msg("user", "hi").model, null);
  });

  test("is immutable", () => {
    const m = msg("user", "hi");
    assert.throws(() => {
      m.content = "changed";
    }, TypeError);
  });

  test("with() returns a copy, leaving the original untouched", () => {
    const original = msg("assistant", "part", { finishReason: FinishReason.LENGTH });
    const extended = original.with({ content: "part two" });
    assert.equal(original.content, "part");
    assert.equal(extended.content, "part two");
    assert.equal(extended.finishReason, FinishReason.LENGTH);
  });

  test("only a length-truncated assistant turn is continuable", () => {
    // Continuing a completed turn has nothing to add; continuing a cancelled
    // one extends output the user never accepted.
    assert.ok(msg("assistant", "x", { finishReason: FinishReason.LENGTH }).isContinuable);
    assert.ok(!msg("assistant", "x", { finishReason: FinishReason.STOP }).isContinuable);
    assert.ok(!msg("assistant", "x", { finishReason: FinishReason.CANCELLED }).isContinuable);
    assert.ok(!msg("user", "x", { finishReason: FinishReason.LENGTH }).isContinuable);
  });
});

describe("ConversationSettings", () => {
  test("clamps rather than rejects out-of-range values", () => {
    // A slightly wrong temperature is not worth failing a user's message over.
    const s = new ConversationSettings({ temperature: 9, topP: -1, maxTokens: 0 });
    assert.equal(s.temperature, 2);
    assert.equal(s.topP, 0);
    assert.equal(s.maxTokens, 1);
  });

  test("an unknown switch policy falls back to the safe default", () => {
    // Silently becoming "never" would strand users on a dead provider.
    assert.equal(new ConversationSettings({ switchPolicy: "sometimes" }).switchPolicy, "auto");
  });

  test("merge overlays only defined values", () => {
    const base = new ConversationSettings({ temperature: 0.2, systemPrompt: "be terse" });
    const merged = base.merge({ temperature: undefined, maxTokens: 500 });
    assert.equal(merged.temperature, 0.2, "undefined must not clear a stored value");
    assert.equal(merged.maxTokens, 500);
    assert.equal(merged.systemPrompt, "be terse");
  });

  test("explicit null unpins the model", () => {
    // Distinct from undefined: null is "let the router choose again".
    const base = new ConversationSettings({ model: "pinned-model" });
    assert.equal(base.merge({ model: null }).model, null);
    assert.equal(base.merge({}).model, "pinned-model");
  });
});

describe("Thread — mutation returns new instances", () => {
  test("appending never mutates the original", () => {
    // Two tabs sending on one thread is a real scenario; a mutable aggregate
    // makes the interleaving impossible to reason about.
    const original = threadWith();
    const next = original.appendUserMessage(msg("user", "hello"));
    assert.equal(original.messages.length, 0);
    assert.equal(next.messages.length, 1);
  });

  test("the title derives from the first user message only", () => {
    const first = threadWith().appendUserMessage(msg("user", "How do I deploy this?"));
    assert.equal(first.title, "How do I deploy this?");

    const second = first
      .appendAssistantMessage(msg("assistant", "like so"))
      .appendUserMessage(msg("user", "and rollback?"));
    assert.equal(second.title, "How do I deploy this?", "later messages must not retitle");
  });

  test("the title is bounded and uses the first non-empty line", () => {
    const t = threadWith().appendUserMessage(msg("user", `\n\nreal question\nmore detail`));
    assert.equal(t.title, "real question");
  });

  test("message count and totals track appends", () => {
    const t = threadWith()
      .appendUserMessage(msg("user", "q"))
      .appendAssistantMessage(msg("assistant", "a", { usage: { totalTokens: 42 } }));
    assert.equal(t.messageCount, 2);
    assert.equal(t.totalTokens, 42);
  });
});

describe("Thread — rewind and replace", () => {
  const built = () =>
    threadWith()
      .appendUserMessage(msg("user", "q1", { id: "u1" }))
      .appendAssistantMessage(msg("assistant", "a1", { id: "a1" }))
      .appendUserMessage(msg("user", "q2", { id: "u2" }))
      .appendAssistantMessage(msg("assistant", "a2", { id: "a2" }));

  test("truncateFrom drops the message and everything after it", () => {
    // Regeneration rewinds so the model does not see its own previous answer.
    const rewound = built().truncateFrom("a2");
    assert.deepEqual(rewound.messages.map((m) => m.id), ["u1", "a1", "u2"]);
    assert.equal(rewound.messageCount, 3);
  });

  test("truncateFrom on an unknown id is a 404, not a silent no-op", () => {
    assert.throws(() => built().truncateFrom("nope"), (e) => e.kind === ErrorKind.NOT_FOUND);
  });

  test("replaceMessage edits in place and keeps position", () => {
    // Continue appends to the existing assistant turn: two consecutive
    // assistant messages are malformed dialogue.
    const updated = built().replaceMessage("a2", { content: "a2 extended" });
    assert.equal(updated.messages.at(-1).content, "a2 extended");
    assert.equal(updated.messages.length, 4);
  });

  test("historyBefore excludes the named message and everything after", () => {
    assert.deepEqual(built().historyBefore("u2").map((m) => m.id), ["u1", "a1"]);
  });

  test("lastAssistantMessage finds the most recent one", () => {
    assert.equal(built().lastAssistantMessage.id, "a2");
  });
});

describe("Thread — lifecycle", () => {
  test("rename trims and bounds", () => {
    assert.equal(threadWith().rename("  spaced  ").title, "spaced");
    assert.equal(threadWith().rename("x".repeat(300)).title.length, 120);
  });

  test("rename rejects an empty title", () => {
    assert.throws(() => threadWith().rename("   "), (e) => e.kind === ErrorKind.VALIDATION);
  });

  test("delete is soft, so the undo window is real", () => {
    const deleted = threadWith().markDeleted(new Date("2026-01-01"));
    assert.ok(deleted.deletedAt);
  });

  test("pinning a message survives a round trip through JSON", () => {
    const t = threadWith().appendUserMessage(msg("user", "keep this", { id: "u1" }));
    const pinned = t.setPinned("u1", true);
    assert.equal(new Thread(pinned.toJSON()).findMessage("u1").pinned, true);
  });

  test("the correction factor persists on the thread", () => {
    // So the estimator does not relearn this conversation's density on restart.
    assert.equal(threadWith().withCorrectionFactor(1.2).tokenCorrectionFactor, 1.2);
  });
});

describe("StreamRegistry", () => {
  const build = () => new StreamRegistry({ clock: new FakeClock(0) });

  test("registers and stops a stream", () => {
    const registry = build();
    const controller = registry.register("s1", { threadId: "t1" });
    assert.equal(registry.stop("s1"), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(registry.has("s1"), false);
  });

  test("stopping an unknown stream is false, not an error", () => {
    // A finished stream is a race, not a client error.
    assert.equal(build().stop("ghost"), false);
  });

  test("a stream cannot be stopped by another owner", () => {
    // Without the check, anyone who guessed an id could cancel someone else's
    // generation.
    const registry = build();
    registry.register("s1", { threadId: "t1", ownerId: "alice" });
    assert.equal(registry.stop("s1", "mallory"), false);
    assert.equal(registry.stop("s1", "alice"), true);
  });

  test("a client disconnect aborts the stream independently of stop", () => {
    const registry = build();
    const upstream = new AbortController();
    const controller = registry.register("s1", { threadId: "t1", signal: upstream.signal });
    upstream.abort();
    assert.equal(controller.signal.aborted, true);
  });

  test("entries expire so a dead stream cannot leak a controller", () => {
    const clock = new FakeClock(0);
    const registry = new StreamRegistry({ clock, maxAgeMs: 1000 });
    registry.register("old", { threadId: "t1" });
    clock.advance(2000);
    registry.register("new", { threadId: "t2" }); // triggers the sweep
    assert.equal(registry.has("old"), false);
    assert.equal(registry.has("new"), true);
  });

  test("stopAll clears everything, for shutdown", () => {
    const registry = build();
    registry.register("a", { threadId: "t" });
    registry.register("b", { threadId: "t" });
    registry.stopAll();
    assert.equal(registry.size, 0);
  });

  test("the abort reason is a CancelledError, never a provider failure", () => {
    // Recording it as a failure would open a breaker on a healthy provider.
    const registry = build();
    const controller = registry.register("s1", { threadId: "t1" });
    registry.stop("s1");
    assert.ok(CancelledError.is(controller.signal.reason));
  });
});
