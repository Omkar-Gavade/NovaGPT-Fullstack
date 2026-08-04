import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EnvelopeCipher, safeEqual } from "../../src/infrastructure/security/EnvelopeCipher.js";
import { parseCookies, serializeCookie, clearCookie } from "../../src/infrastructure/security/cookies.js";

describe("EnvelopeCipher", () => {
  const cipher = new EnvelopeCipher({ masterKey: EnvelopeCipher.generateMasterKey() });

  test("round-trips a secret", () => {
    const record = cipher.encrypt("sk-live-abcdef123456");
    assert.equal(cipher.decrypt(record), "sk-live-abcdef123456");
  });

  test("the stored record contains no plaintext and no master key", () => {
    const record = cipher.encrypt("sk-live-abcdef123456");
    const json = JSON.stringify(record);
    assert.ok(!json.includes("sk-live"));
    assert.ok(!json.includes(cipher.masterKey.toString("base64")));
  });

  test("uses a fresh data key per record", () => {
    // One shared data key would mean a single compromise exposes every user's
    // secrets at once.
    const a = cipher.encrypt("same-secret");
    const b = cipher.encrypt("same-secret");
    assert.notEqual(a.wrappedKey, b.wrappedKey);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test("tampering fails decryption rather than producing garbage", () => {
    // Garbage would be sent to a provider, rejected as an auth failure, and
    // send debugging in entirely the wrong direction.
    const record = cipher.encrypt("sk-live-abcdef123456");
    const flipped = { ...record, ciphertext: Buffer.from("tampered").toString("base64") };
    assert.throws(() => cipher.decrypt(flipped));
  });

  test("a different master key cannot unwrap the record", () => {
    const other = new EnvelopeCipher({ masterKey: EnvelopeCipher.generateMasterKey() });
    assert.throws(() => other.decrypt(cipher.encrypt("secret-value")));
  });

  test("rotation re-wraps the data key and leaves the payload untouched", () => {
    // The whole point: rotation is proportional to the number of records, not
    // to the volume of data, and cannot corrupt a payload it never touches.
    const record = cipher.encrypt("sk-live-abcdef123456");
    const next = new EnvelopeCipher({
      masterKey: EnvelopeCipher.generateMasterKey(),
      masterKeyId: "2026-q3",
    });

    const rotated = cipher.rewrap(record, next);
    assert.equal(rotated.ciphertext, record.ciphertext);
    assert.equal(rotated.masterKeyId, "2026-q3");
    assert.equal(next.decrypt(rotated), "sk-live-abcdef123456");
  });

  test("refuses a master key of the wrong size", () => {
    assert.throws(() => new EnvelopeCipher({ masterKey: "dG9vLXNob3J0" }), TypeError);
  });

  test("the mask identifies a key without revealing it", () => {
    assert.equal(EnvelopeCipher.mask("sk-live-abcdef123456"), "sk-…3456");
    assert.equal(EnvelopeCipher.mask("short"), "…");
  });
});

describe("safeEqual", () => {
  test("compares without leaking length-independent timing", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    // Different lengths must return false rather than throwing, which is what
    // `timingSafeEqual` does on its own.
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual(null, undefined), true);
  });
});

describe("cookies", () => {
  test("parses a cookie header", () => {
    const parsed = parseCookies("a=1; nova_refresh=tok%20en; b=2");
    assert.equal(parsed.nova_refresh, "tok en");
    assert.equal(parsed.a, "1");
  });

  test("survives a malformed third-party cookie", () => {
    // A cookie we did not set must not make an unrelated request throw.
    const parsed = parseCookies("=nameless; broken; ok=1; bad=%E0%A4%A");
    assert.equal(parsed.ok, "1");
    assert.equal(parsed.bad, "%E0%A4%A");
  });

  test("returns an empty object for no header", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(""), {});
  });

  test("the refresh cookie is httpOnly, Strict and Secure in production", () => {
    const header = serializeCookie({
      name: "nova_refresh",
      value: "tok",
      maxAgeMs: 60_000,
      secure: true,
    });

    // httpOnly is what keeps an XSS bug to a 15-minute access token instead of
    // 30 days of account access (T6).
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Secure/);
    assert.match(header, /Max-Age=60/);
  });

  test("omits Secure for plain-HTTP local development", () => {
    // A Secure cookie is never sent over HTTP, so leaving it on would make the
    // local flow fail silently.
    assert.ok(!serializeCookie({ name: "c", value: "v", maxAgeMs: 1000, secure: false }).includes("Secure"));
  });

  test("clearing repeats path and domain, or the browser keeps the original", () => {
    const header = clearCookie({ name: "nova_refresh", secure: true, domain: "novagpt.test" });
    assert.match(header, /Max-Age=0/);
    assert.match(header, /Path=\//);
    assert.match(header, /Domain=novagpt\.test/);
  });
});
