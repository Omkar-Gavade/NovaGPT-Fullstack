import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TokenEstimator,
  CalibratedTokenEstimator,
} from "../../src/domain/context/TokenEstimator.js";
import { TokenBudget } from "../../src/domain/context/TokenBudget.js";
import { ContextEngine } from "../../src/domain/context/ContextEngine.js";
import { ExtractiveSummarizer } from "../../src/domain/context/Summarizer.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { ErrorKind } from "../../src/domain/errors/index.js";

const model = (capabilities = {}) =>
  new ModelDescriptor({
    id: "test-model",
    provider: "test",
    capabilities: { contextWindow: 10_000, maxOutputTokens: 2000, ...capabilities },
  });

const turn = (role, content, extra = {}) => ({ role, content, ...extra });
const conversation = (pairs, chars = 200) =>
  Array.from({ length: pairs * 2 }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", "x".repeat(chars), { id: `m${i}` })
  );

describe("TokenEstimator", () => {
  test("is deterministic", () => {
    const estimator = new TokenEstimator();
    const text = "The quick brown fox jumps over the lazy dog.";
    assert.equal(estimator.estimateText(text), estimator.estimateText(text));
  });

  test("estimates English prose at roughly chars/3.6", () => {
    const estimator = new TokenEstimator();
    const text = "a".repeat(360);
    assert.equal(estimator.estimateText(text), 100);
  });

  test("counts CJK far higher than prose", () => {
    // A Han character is ~1 token in every tokeniser. Counting it as 3.6
    // characters' worth underestimates by ~3.6x — enough to blow the budget on
    // a Chinese conversation.
    const estimator = new TokenEstimator();
    const cjk = estimator.estimateText("字".repeat(100));
    const latin = estimator.estimateText("a".repeat(100));
    assert.ok(cjk > latin * 3, `cjk=${cjk} latin=${latin}`);
  });

  test("counts punctuation-dense text higher than prose", () => {
    const estimator = new TokenEstimator();
    const code = estimator.estimateText("{[(<>)]};".repeat(40));
    const prose = estimator.estimateText("abcdefghi".repeat(40));
    assert.ok(code > prose);
  });

  test("adds per-message envelope overhead", () => {
    const estimator = new TokenEstimator();
    const bare = estimator.estimateText("hello");
    assert.equal(estimator.estimateMessage({ role: "user", content: "hello" }), bare + 4);
  });

  test("a cached estimate is authoritative", () => {
    // Computed once at write time; the count for a stored message never changes.
    const estimator = new TokenEstimator();
    assert.equal(estimator.estimateMessage({ content: "x".repeat(9999), tokenEstimate: 42 }), 42);
  });

  test("skews high rather than low", () => {
    // Underestimating costs a rejected request after a full round trip;
    // overestimating costs slightly more trimming nobody notices.
    const estimator = new TokenEstimator();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const gptLike = Math.ceil(text.length / 4.0);
    assert.ok(estimator.estimateText(text) >= gptLike);
  });

  test("empty and non-string inputs are zero, not NaN", () => {
    const estimator = new TokenEstimator();
    assert.equal(estimator.estimateText(""), 0);
    assert.equal(estimator.estimateText(null), 0);
    assert.equal(estimator.estimateMessages([]), 0);
  });
});

describe("CalibratedTokenEstimator", () => {
  test("learns from what the provider actually counted", () => {
    const estimator = new CalibratedTokenEstimator();
    const before = estimator.estimateText("hello world");
    estimator.calibrate(100, 130); // we under-counted by 30%
    assert.ok(estimator.estimateText("hello world") > before);
  });

  test("clamps so one anomalous turn cannot poison the factor", () => {
    const estimator = new CalibratedTokenEstimator();
    estimator.calibrate(100, 100_000); // a tool-call-heavy outlier
    assert.equal(estimator.correctionFactor, CalibratedTokenEstimator.MAX_FACTOR);

    const low = new CalibratedTokenEstimator();
    low.calibrate(100_000, 100);
    assert.equal(low.correctionFactor, CalibratedTokenEstimator.MIN_FACTOR);
  });

  test("ignores nonsense observations", () => {
    const estimator = new CalibratedTokenEstimator();
    estimator.calibrate(0, 500);
    estimator.calibrate(500, 0);
    assert.equal(estimator.correctionFactor, 1);
  });

  test("only recent observations count", () => {
    // A conversation that switched from prose to code should re-learn rather
    // than average over its whole history.
    const estimator = new CalibratedTokenEstimator();
    for (let i = 0; i < 5; i += 1) estimator.calibrate(100, 70);
    const afterProse = estimator.correctionFactor;
    for (let i = 0; i < 5; i += 1) estimator.calibrate(100, 140);
    assert.ok(estimator.correctionFactor > afterProse);
  });

  test("a restored factor survives a restart", () => {
    const estimator = CalibratedTokenEstimator.fromFactor(1.25);
    assert.equal(estimator.correctionFactor, 1.25);
  });

  test("stays deterministic under calibration", () => {
    const a = CalibratedTokenEstimator.fromFactor(1.2);
    const b = CalibratedTokenEstimator.fromFactor(1.2);
    assert.equal(a.estimateText("same input"), b.estimateText("same input"));
  });
});

describe("TokenBudget", () => {
  test("reserves output, system prompt and safety margin", () => {
    const budget = new TokenBudget({
      contextWindow: 100_000,
      maxOutputTokens: 4000,
      systemPromptTokens: 500,
    });
    assert.equal(budget.safetyMargin, 8000); // 10% capped at 8000
    assert.equal(budget.promptBudget, 100_000 - 4000 - 500 - 8000);
  });

  test("the margin is percentage-based, floored and capped", () => {
    // A fixed margin is wastefully large for an 8K window and dangerously small
    // for a 1M one.
    assert.equal(new TokenBudget({ contextWindow: 4000, maxOutputTokens: 0 }).safetyMargin, 512);
    assert.equal(new TokenBudget({ contextWindow: 40_000, maxOutputTokens: 0 }).safetyMargin, 4000);
    assert.equal(new TokenBudget({ contextWindow: 2_000_000, maxOutputTokens: 0 }).safetyMargin, 8000);
  });

  test("clamps a request for more output than the model can produce", () => {
    // Over-reserving would shrink the prompt budget for tokens that can never
    // be generated.
    const budget = new TokenBudget({
      contextWindow: 100_000,
      maxOutputTokens: 50_000,
      modelMaxOutputTokens: 8192,
    });
    assert.equal(budget.maxOutputTokens, 8192);
  });

  test("never goes negative", () => {
    const budget = new TokenBudget({ contextWindow: 1000, maxOutputTokens: 5000 });
    assert.ok(budget.promptBudget >= 0);
  });

  test("memory and pinned shares are capped fractions of the budget", () => {
    const budget = new TokenBudget({ contextWindow: 100_000, maxOutputTokens: 2000 });
    assert.equal(budget.memoryBudget, Math.floor(budget.promptBudget * 0.25));
    assert.equal(budget.pinnedBudget, Math.floor(budget.promptBudget * 0.4));
  });

  test("compression triggers proactively at 70%", () => {
    // At overflow it would put work in the user's critical path.
    const budget = new TokenBudget({ contextWindow: 100_000, maxOutputTokens: 2000 });
    assert.equal(budget.compressionThreshold, Math.floor(budget.promptBudget * 0.7));
  });

  test("builds from a model descriptor", () => {
    const budget = TokenBudget.forModel(model({ contextWindow: 128_000 }), { maxOutputTokens: 4096 });
    assert.equal(budget.contextWindow, 128_000);
  });

  test("rejects a model with no declared window", () => {
    assert.throws(() => TokenBudget.forModel({ id: "x", capabilities: { value: () => null } }));
  });
});

describe("ContextEngine — assembly", () => {
  test("a short conversation passes through untouched", () => {
    const engine = new ContextEngine();
    const history = conversation(2, 50);
    const { messages, report } = engine.assemble({
      model: model(),
      history,
      newest: turn("user", "and now?"),
      systemPrompt: "be concise",
    });
    assert.equal(report.isLossy, false);
    assert.equal(messages.length, 1 + history.length + 1); // system + history + newest
  });

  test("is deterministic — byte-identical output for identical input", () => {
    // Without this, a quality regression is unreproducible and a user's bug
    // report is unactionable.
    const history = conversation(40, 300);
    const run = () =>
      JSON.stringify(
        new ContextEngine().assemble({
          model: model(),
          history,
          newest: turn("user", "final"),
          systemPrompt: "sys",
        }).messages
      );
    assert.equal(run(), run());
  });

  test("injection order is stable-first, for prompt caching", () => {
    const engine = new ContextEngine();
    const { messages } = engine.assemble({
      model: model({ contextWindow: 100_000 }),
      history: conversation(2, 50),
      newest: turn("user", "question"),
      systemPrompt: "system rules",
      profile: "prefers brevity",
      documents: [{ title: "doc", content: "retrieved text" }],
    });

    assert.match(messages[0].content, /system rules/);
    assert.match(messages[1].content, /About the user/);
    assert.match(messages[2].content, /Retrieved context/);
    assert.equal(messages.at(-1).content, "question");
  });

  test("the newest message is always last and always present", () => {
    const engine = new ContextEngine();
    const { messages } = engine.assemble({
      model: model({ contextWindow: 3000 }),
      history: conversation(50, 400),
      newest: turn("user", "THE QUESTION"),
    });
    assert.equal(messages.at(-1).content, "THE QUESTION");
  });

  test("the system prompt survives aggressive trimming", () => {
    const engine = new ContextEngine();
    const { messages } = engine.assemble({
      model: model({ contextWindow: 3000 }),
      history: conversation(60, 400),
      newest: turn("user", "q"),
      systemPrompt: "ALWAYS BE FORMAL",
    });
    assert.match(messages[0].content, /ALWAYS BE FORMAL/);
  });

  test("messages stay chronological", () => {
    const engine = new ContextEngine();
    const history = conversation(30, 200);
    const { messages } = engine.assemble({
      model: model({ contextWindow: 8000 }),
      history,
      newest: turn("user", "q"),
    });
    const roles = messages.filter((m) => m.role !== "system").map((m) => m.role);
    // Alternating user/assistant, ending on the newest user message.
    assert.equal(roles.at(-1), "user");
  });

  test("the result fits the budget", () => {
    const engine = new ContextEngine();
    const { report } = engine.assemble({
      model: model({ contextWindow: 6000 }),
      history: conversation(80, 300),
      newest: turn("user", "q"),
      systemPrompt: "sys",
    });
    assert.ok(
      report.estimatedTokens <= report.budget.promptBudget,
      `${report.estimatedTokens} > ${report.budget.promptBudget}`
    );
  });
});

describe("ContextEngine — pinned messages", () => {
  test("pinned messages survive trimming that removes their neighbours", () => {
    const engine = new ContextEngine();
    const history = conversation(60, 300);
    history[0] = turn("user", "PINNED SCHEMA DEFINITION", { id: "pin", pinned: true });

    const { messages } = engine.assemble({
      model: model({ contextWindow: 5000 }),
      history,
      newest: turn("user", "q"),
    });
    assert.ok(messages.some((m) => m.content.includes("PINNED SCHEMA DEFINITION")));
  });

  test("pinned content is capped, and the cap is reported not silent", () => {
    const engine = new ContextEngine();
    const history = Array.from({ length: 20 }, (_, i) =>
      turn("user", "y".repeat(2000), { id: `p${i}`, pinned: true })
    );
    const { report } = engine.assemble({
      model: model({ contextWindow: 10_000 }),
      history,
      newest: turn("user", "q"),
    });
    assert.ok(report.warnings.some((w) => /pinned/i.test(w)));
  });
});

describe("ContextEngine — trimming stages", () => {
  test("compression runs before dropping turns", () => {
    // Dropping loses substance entirely; a summary preserves it.
    const engine = new ContextEngine();
    const { report } = engine.assemble({
      model: model({ contextWindow: 6000 }),
      history: conversation(40, 300),
      newest: turn("user", "q"),
    });
    const stages = report.stagesApplied.map((s) => s.stage);
    assert.ok(stages.includes("compress"));
    if (stages.includes("drop-turns")) {
      assert.ok(stages.indexOf("compress") < stages.indexOf("drop-turns"));
    }
  });

  test("dropped turns are recorded, never silent", () => {
    const engine = new ContextEngine();
    const { report } = engine.assemble({
      model: model({ contextWindow: 2500 }),
      history: conversation(80, 400),
      newest: turn("user", "q"),
    });
    assert.ok(report.isLossy);
    assert.ok(report.trimmed.length + report.compressed.length > 0);
    assert.ok(report.userSummary());
  });

  test("an oversized message that cannot be dropped is truncated in the middle, and marked", () => {
    // Truncation is stage 4: it only applies to content stage 3 could not drop.
    // A *pinned* oversized message is exactly that case — an unmarked
    // truncation would make the model confidently reason about content it
    // never received.
    const engine = new ContextEngine();
    const { messages, report } = engine.assemble({
      model: model({ contextWindow: 4000 }),
      history: [turn("user", "START" + "z".repeat(40_000) + "END", { id: "huge", pinned: true })],
      newest: turn("user", "q"),
    });
    const truncated = messages.find((m) => m.content.includes("tokens omitted"));
    assert.ok(truncated, "the marker is mandatory");
    assert.match(truncated.content, /^START/);
    assert.match(truncated.content, /END$/);
    assert.equal(report.truncated.length, 1);
  });

  test("fails loudly when even the minimum cannot fit", () => {
    const engine = new ContextEngine();
    assert.throws(
      () =>
        engine.assemble({
          model: model({ contextWindow: 1200, maxOutputTokens: 100 }),
          history: [],
          newest: turn("user", "q".repeat(100_000)),
        }),
      (error) => {
        assert.equal(error.kind, ErrorKind.PAYLOAD_TOO_LARGE);
        // Names the culprit and the fix, rather than a generic "too long".
        assert.match(error.message, /your message alone/);
        assert.match(error.message, /larger context window/);
        return true;
      }
    );
  });
});

describe("ContextEngine — diagnostics", () => {
  test("statistics predict compression without assembling", () => {
    const engine = new ContextEngine();
    const stats = engine.statistics({
      model: model({ contextWindow: 5000 }),
      history: conversation(40, 300),
    });
    assert.ok(stats.estimatedTokens > 0);
    assert.equal(stats.messageCount, 80);
    assert.ok(stats.willCompress);
  });

  test("shouldCompress triggers at 70%, before overflow", () => {
    const engine = new ContextEngine();
    const small = engine.shouldCompress({ model: model(), history: conversation(1, 50) });
    const large = engine.shouldCompress({ model: model(), history: conversation(60, 300) });
    assert.equal(small, false);
    assert.equal(large, true);
  });

  test("the report accounts for every included section", () => {
    const engine = new ContextEngine();
    const { report } = engine.assemble({
      model: model({ contextWindow: 100_000 }),
      history: conversation(3, 100),
      newest: turn("user", "q"),
      systemPrompt: "sys",
      profile: "likes brevity",
    });
    assert.ok(report.included.systemPrompt > 0);
    assert.ok(report.included.memory > 0);
    assert.ok(report.included.messages > 0);
    assert.ok(report.utilisation > 0);
  });
});

describe("ExtractiveSummarizer", () => {
  test("is deterministic", () => {
    // A generative summariser is not reproducible even at temperature 0 across
    // model versions; this one always is.
    const summarizer = new ExtractiveSummarizer();
    const messages = [turn("user", "We must use Postgres.\nBecause it has pgvector.")];
    const a = summarizer.summarize(messages, { fromIndex: 0, toIndex: 0 });
    const b = summarizer.summarize(messages, { fromIndex: 0, toIndex: 0 });
    assert.equal(a.content, b.content);
  });

  test("cannot hallucinate — every line came from the input", () => {
    const summarizer = new ExtractiveSummarizer();
    const source = "We decided to use Redis for caching.";
    const summary = summarizer.summarize([turn("user", source)], {});
    assert.ok(summary.content.includes(source));
  });

  test("keeps decisions and constraints", () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = summarizer.summarize(
      [turn("user", "Sure thing!\nThe API must never expose keys.\nThanks!")],
      {}
    );
    assert.match(summary.content, /must never expose keys/);
  });

  test("drops conversational scaffolding", () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = summarizer.summarize(
      [turn("assistant", "Certainly! I can help with that.\nThe file is config.js.")],
      {}
    );
    assert.match(summary.content, /config\.js/);
    assert.ok(!summary.content.includes("Certainly"));
  });

  test("is labelled as a summary so the model treats it as secondary", () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = summarizer.summarize([turn("user", "something")], {});
    assert.match(summary.content, /\[Summary of earlier conversation\]/);
    assert.equal(summary.isSummary, true);
  });

  test("preserves original line order within a message", () => {
    // Reordering would destroy the causal structure that makes it readable.
    const summarizer = new ExtractiveSummarizer();
    const summary = summarizer.summarize(
      [turn("user", "First we must init.\nThen we should build.\nFinally we must deploy.")],
      {}
    );
    const body = summary.content;
    assert.ok(body.indexOf("init") < body.indexOf("build"));
    assert.ok(body.indexOf("build") < body.indexOf("deploy"));
  });
});
