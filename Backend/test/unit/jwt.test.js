import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { JwtSigner } from "../../src/infrastructure/security/JwtSigner.js";

/**
 * The token codec.
 *
 * Most of these are attacks rather than features. A JWT implementation that
 * round-trips correctly and rejects nothing is worse than no tokens at all,
 * because it looks like authentication.
 */

const keys = JwtSigner.generateKeyPair();
const other = JwtSigner.generateKeyPair();

function build({ now = () => Date.now(), ...overrides } = {}) {
  return new JwtSigner({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    issuer: "novagpt",
    audience: "novagpt-api",
    clock: { now },
    ...overrides,
  });
}

describe("JwtSigner", () => {
  test("round-trips claims", () => {
    const signer = build();
    const token = signer.sign({ sub: "user-1", role: "user", type: "access" }, 60_000);
    const result = signer.verify(token);

    assert.equal(result.valid, true);
    assert.equal(result.claims.sub, "user-1");
    assert.equal(result.claims.role, "user");
    assert.ok(result.claims.jti, "every token needs an id, or it cannot be revoked");
  });

  test("rejects a token signed with a different key", () => {
    const token = build().sign({ sub: "user-1" }, 60_000);
    const impostor = new JwtSigner({
      privateKey: other.privateKey,
      publicKey: other.publicKey,
      issuer: "novagpt",
      audience: "novagpt-api",
      clock: { now: () => Date.now() },
    });

    assert.equal(impostor.verify(token).reason, "signature");
  });

  test("rejects `alg: none`", () => {
    // The classic JWT attack: strip the signature and declare the token
    // unsigned. An implementation that reads `alg` from the header to choose a
    // verifier accepts it.
    const signer = build();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "admin", iss: "novagpt", aud: "novagpt-api", exp: 9e9 })
    ).toString("base64url");

    assert.equal(signer.verify(`${header}.${payload}.`).valid, false);
  });

  test("rejects a token whose header claims a different algorithm", () => {
    // Same family: `alg: HS256` with the RSA *public* key as the HMAC secret.
    // The public key is not secret, so anyone can forge this against an
    // implementation that trusts the header.
    const signer = build();
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "admin", iss: "novagpt", aud: "novagpt-api", exp: 9e9 })
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(keys.privateKey);

    assert.equal(signer.verify(`${signingInput}.${signature.toString("base64url")}`).valid, false);
  });

  test("rejects an expired token", () => {
    let now = 1_000_000;
    const signer = build({ now: () => now });
    const token = signer.sign({ sub: "user-1" }, 1000);

    now += 60_000;
    assert.equal(signer.verify(token).reason, "expired");
  });

  test("tolerates a small clock difference rather than failing a valid token", () => {
    let now = 1_000_000;
    const signer = build({ now: () => now });
    const token = signer.sign({ sub: "user-1" }, 1000);

    // Unsynchronised clocks are normal; a hard boundary produces intermittent
    // logouts that nobody can reproduce.
    now += 5_000;
    assert.equal(signer.verify(token).valid, true);
  });

  test("rejects a token minted for another issuer or audience", () => {
    const foreign = new JwtSigner({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      issuer: "someone-else",
      audience: "novagpt-api",
      clock: { now: () => Date.now() },
    });

    assert.equal(build().verify(foreign.sign({ sub: "u" }, 60_000)).reason, "issuer");
  });

  test("rejects garbage without throwing", () => {
    const signer = build();
    for (const input of ["", "abc", "a.b", "a.b.c", null, undefined, "..", "{}"]) {
      assert.equal(signer.verify(input).valid, false);
    }
  });

  test("accepts tokens signed by the previous key during a rotation", () => {
    // A rotation that invalidates every live token is a rotation that gets
    // deferred forever (docs/backend/10-security.md#rotation).
    const oldSigner = build();
    const token = oldSigner.sign({ sub: "user-1" }, 60_000);

    const rotated = new JwtSigner({
      privateKey: other.privateKey,
      publicKey: other.publicKey,
      previousPublicKeys: [keys.publicKey],
      issuer: "novagpt",
      audience: "novagpt-api",
      clock: { now: () => Date.now() },
    });

    assert.equal(rotated.verify(token).valid, true);
    assert.notEqual(rotated.keyId, oldSigner.keyId, "a rotated key must have a new id");
  });

  test("names the signing key so a verifier can tell a rotation from an attack", () => {
    const signer = build();
    const [header] = signer.sign({ sub: "u" }, 60_000).split(".");
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    assert.equal(decoded.kid, signer.keyId);
  });
});
