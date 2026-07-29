import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, redactString } from "../../src/infrastructure/telemetry/redact.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";

describe("redact — by key name", () => {
  test("scrubs values under credential-shaped keys", () => {
    const out = redact({
      apiKey: "anything",
      api_key: "anything",
      authorization: "Basic dXNlcjpwYXNz",
      password: "hunter2",
      sessionToken: "abc",
      user_secret: "s",
      safe: "visible",
    });
    assert.equal(out.apiKey, "[REDACTED]");
    assert.equal(out.api_key, "[REDACTED]");
    assert.equal(out.authorization, "[REDACTED]");
    assert.equal(out.password, "[REDACTED]");
    assert.equal(out.sessionToken, "[REDACTED]");
    assert.equal(out.user_secret, "[REDACTED]");
    assert.equal(out.safe, "visible");
  });

  test("scrubs nested credential keys", () => {
    const out = redact({ provider: { config: { apiKey: "sk-secret" } } });
    assert.equal(out.provider.config.apiKey, "[REDACTED]");
  });

  test("does not over-match innocuous keys", () => {
    const out = redact({ keyboard: "qwerty", monkey: "banana", tokenizer: "bpe" });
    assert.equal(out.keyboard, "qwerty");
    assert.equal(out.monkey, "banana");
    assert.equal(out.tokenizer, "bpe");
  });
});

describe("redact — by value shape", () => {
  const cases = [
    ["OpenAI", "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["Google", "AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    ["Groq", "gsk_CCCCCCCCCCCCCCCCCCCCCCCC"],
    ["Hugging Face", "hf_DDDDDDDDDDDDDDDDDDDDDDDD"],
    ["GitHub", "ghp_EEEEEEEEEEEEEEEEEEEEEEEE"],
  ];

  for (const [name, value] of cases) {
    test(`scrubs a ${name} key found under an innocent field name`, () => {
      const out = redact({ note: `the key is ${value} ok` });
      assert.ok(!out.note.includes(value), out.note);
      assert.ok(out.note.includes("[REDACTED]"));
    });
  }

  test("scrubs a bearer token", () => {
    const out = redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz"));
  });

  test("scrubs a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    assert.ok(!redactString(`token=${jwt}`).includes("eyJzdWIi"));
  });

  test("scrubs credentials from a connection string but keeps it diagnostic", () => {
    const out = redactString("mongodb+srv://admin:s3cr3tP4ss@cluster0.mongodb.net/nova");
    assert.ok(!out.includes("s3cr3tP4ss"), out);
    assert.ok(!out.includes("admin"), out);
    // Scheme and host survive, so the log still says which database failed.
    assert.ok(out.includes("mongodb+srv://"), out);
    assert.ok(out.includes("cluster0.mongodb.net"), out);
  });
});

describe("redact — structural hazards", () => {
  test("unwraps a Secret", () => {
    assert.equal(redact(new Secret("value", "K")), "[REDACTED:K]");
    assert.equal(redact({ uri: new Secret("value", "K") }).uri, "[REDACTED:K]");
  });

  test("handles circular references without throwing", () => {
    const node = { name: "a" };
    node.self = node;
    assert.equal(redact(node).self, "[Circular]");
  });

  test("bounds depth", () => {
    let deep = { value: "bottom" };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    assert.doesNotThrow(() => JSON.stringify(redact(deep)));
  });

  test("serialises Errors, whose fields are otherwise non-enumerable", () => {
    const error = new Error("boom");
    error.code = "E_BOOM";
    const out = redact(error);
    assert.equal(out.name, "Error");
    assert.equal(out.message, "boom");
    assert.equal(out.code, "E_BOOM");
    assert.ok(out.stack);
    // The default would be "{}", which is the classic useless production log.
    assert.notEqual(JSON.stringify(out), "{}");
  });

  test("scrubs credentials inside an error message and cause chain", () => {
    const cause = new Error("connect failed for sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA");
    const out = redact(new Error("wrapper", { cause }));
    assert.ok(!JSON.stringify(out).includes("sk-proj-AAAA"));
  });

  test("does not throw on BigInt", () => {
    assert.equal(redact({ n: 10n }).n, "10n");
  });

  test("truncates very long strings", () => {
    const out = redactString("x".repeat(5000));
    assert.ok(out.length < 2200);
    assert.ok(out.endsWith("[truncated]"));
  });

  test("passes primitives through unchanged", () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
  });
});
