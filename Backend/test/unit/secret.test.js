import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";

/**
 * These tests exist because `Secret` is a security control, not a convenience
 * wrapper (docs/backend/10-security.md, threat T1). Each case below is one way
 * a credential escapes into a log in a real codebase.
 */
describe("Secret", () => {
  const key = "sk-live-abcdef1234567890";

  test("exposes the value only through expose()", () => {
    const secret = new Secret(key, "TEST_KEY");
    assert.equal(secret.expose(), key);
  });

  test("does not leak through String()", () => {
    assert.equal(String(new Secret(key, "TEST_KEY")), "[REDACTED:TEST_KEY]");
  });

  test("does not leak through template literals", () => {
    const secret = new Secret(key, "TEST_KEY");
    assert.equal(`uri=${secret}`, "uri=[REDACTED:TEST_KEY]");
  });

  test("does not leak through string concatenation", () => {
    assert.equal("k:" + new Secret(key, "TEST_KEY"), "k:[REDACTED:TEST_KEY]");
  });

  test("does not leak through JSON.stringify", () => {
    const payload = JSON.stringify({ uri: new Secret(key, "MONGODB_URI") });
    assert.equal(payload, '{"uri":"[REDACTED:MONGODB_URI]"}');
    assert.ok(!payload.includes("sk-live"));
  });

  test("does not leak through util.inspect (console.log)", () => {
    const output = inspect({ key: new Secret(key, "TEST_KEY") });
    assert.ok(!output.includes("sk-live"), output);
    assert.ok(output.includes("[REDACTED:TEST_KEY]"));
  });

  test("does not leak the value through enumerable properties", () => {
    const secret = new Secret(key, "TEST_KEY");
    assert.deepEqual(Object.values(secret), ["TEST_KEY"]);
    assert.ok(!JSON.stringify(Object.keys(secret)).includes(key));
  });

  test("is immutable", () => {
    const secret = new Secret(key, "TEST_KEY");
    assert.throws(() => {
      secret.label = "other";
    }, TypeError);
  });

  test("rejects an empty or non-string value", () => {
    assert.throws(() => new Secret("", "X"), TypeError);
    assert.throws(() => new Secret(undefined, "X"), TypeError);
    assert.throws(() => new Secret(123, "X"), TypeError);
  });

  test("identifies its own instances", () => {
    assert.ok(Secret.is(new Secret("x", "X")));
    assert.ok(!Secret.is("x"));
    assert.ok(!Secret.is(null));
  });
});
