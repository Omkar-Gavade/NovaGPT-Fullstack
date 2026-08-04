import {
  createSign,
  createVerify,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  createHash,
} from "node:crypto";

/**
 * RS256 JSON Web Tokens, implementing `TokenSignerPort`.
 *
 * **Why RS256 and not HS256.** Asymmetric signing means a verifier needs only
 * the public key. With a shared secret, every component that can *check* a
 * token can also *mint* one — a read-only service, a debugging script, and a
 * log shipper all become token forgers the moment they hold the secret
 * (docs/backend/10-security.md#authentication).
 *
 * **Why this is hand-written rather than a JWT library.** JWT is a small,
 * frozen format, and the parts libraries get wrong are the parts that matter:
 * honouring `alg` from the token header (which permits the `alg: none` and
 * HS-with-the-RSA-public-key attacks) and lenient claim checking. Here the
 * algorithm is fixed by this file and the header's `alg` is *verified against*
 * it, never *used to select* it. Every dependency is code we ship and cannot
 * audit (T14), and this one is sixty lines.
 *
 * `verify` returns a result object instead of throwing. An expired token is the
 * most common input this function will ever see, and making the common case an
 * exception is how a `catch` eventually swallows a signature failure too.
 */

const ALG = "RS256";

export class JwtSigner {
  algorithm = ALG;

  /**
   * @param {object} deps
   * @param {string} deps.privateKey PEM (PKCS#8)
   * @param {string} deps.publicKey PEM (SPKI)
   * @param {string[]} [deps.previousPublicKeys] accepted during a key rotation
   * @param {string} deps.issuer
   * @param {string} deps.audience
   * @param {import("../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {number} [deps.clockSkewMs] tolerance for unsynchronised clocks
   */
  constructor({
    privateKey,
    publicKey,
    previousPublicKeys = [],
    issuer,
    audience,
    clock,
    clockSkewMs = 30_000,
  }) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.issuer = issuer;
    this.audience = audience;
    this.clock = clock;
    this.clockSkewMs = clockSkewMs;

    // `kid` names the key that signed a token. During a rotation both keys are
    // live, and without a `kid` a verifier has to try every key on every
    // request and cannot tell a rotation from an attack.
    this.keyId = fingerprint(publicKey);
    this.verifiers = [publicKey, ...previousPublicKeys].filter(Boolean);
  }

  /**
   * Generate an ephemeral key pair.
   *
   * Development only, and it announces itself: tokens signed with a key that
   * lives in one process are invalidated by a restart and are not shared
   * between instances. Production supplies keys from the secret manager
   * (docs/backend/10-security.md#secret-management).
   */
  static generateKeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    return { privateKey, publicKey };
  }

  /**
   * @param {object} claims application claims (`sub`, `role`, `type`, …)
   * @param {number} ttlMs
   */
  sign(claims, ttlMs) {
    const now = Math.floor(this.clock.now() / 1000);
    const header = { alg: ALG, typ: "JWT", kid: this.keyId };
    const payload = {
      ...claims,
      iss: this.issuer,
      aud: this.audience,
      iat: now,
      nbf: now,
      exp: now + Math.floor(ttlMs / 1000),
      jti: claims.jti ?? randomUUID(),
    };

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  /** @returns {{valid: boolean, claims: object|null, reason: string|null}} */
  verify(token) {
    if (typeof token !== "string") return invalid("malformed");

    const parts = token.split(".");
    if (parts.length !== 3) return invalid("malformed");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return invalid("malformed");
    }

    // The algorithm is checked against the one this signer uses, never taken
    // from the token. Taking it from the token is the `alg: none` family of
    // attacks, and it is the single most common JWT implementation flaw.
    if (header?.alg !== ALG) return invalid("signature");

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    let signature;
    try {
      signature = Buffer.from(encodedSignature, "base64url");
    } catch {
      return invalid("malformed");
    }

    const verified = this.verifiers.some((key) => {
      try {
        return createVerify("RSA-SHA256").update(signingInput).verify(key, signature);
      } catch {
        return false;
      }
    });
    if (!verified) return invalid("signature");

    // Claim checks come after the signature check, so nothing unauthenticated
    // is ever acted on — including the timestamps.
    if (claims.iss !== this.issuer) return invalid("issuer");
    if (claims.aud !== this.audience) return invalid("audience");

    const now = this.clock.now();
    const skew = this.clockSkewMs;
    if (typeof claims.exp !== "number" || claims.exp * 1000 + skew <= now) return invalid("expired");
    if (typeof claims.nbf === "number" && claims.nbf * 1000 - skew > now) return invalid("expired");

    return { valid: true, claims, reason: null };
  }
}

const invalid = (reason) => ({ valid: false, claims: null, reason });

const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");

/**
 * A stable, non-secret identifier for a public key. A hash rather than a
 * counter so two deployments holding the same key agree on its name without
 * coordinating.
 */
function fingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}
