import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";

/**
 * Authentication over real HTTP.
 *
 * Real Express, real middleware chain, real token service, real session store.
 * Only the password hasher is substituted, and with a real (cheaper) hashing
 * implementation rather than a stub — a stub comparing plaintext would let
 * every one of these pass while the code under test was broken.
 */

const PASSWORD = "a-long-enough-passphrase";

describe("auth API — registration", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("registers and returns an access token, never the refresh token", async () => {
    const { status, body, response } = await app.post(
      "/api/v1/auth/register",
      { email: "new@novagpt.test", password: PASSWORD },
      { anonymous: true }
    );

    assert.equal(status, 201);
    assert.ok(body.data.accessToken);
    assert.equal(body.data.tokenType, "Bearer");

    // The high-value credential goes out in an httpOnly cookie and never in the
    // body, so an XSS bug steals 15 minutes rather than 30 days (T6).
    assert.ok(!JSON.stringify(body).includes("refreshToken"));
    assert.match(response.headers.get("set-cookie") ?? "", /nova_refresh=.*HttpOnly/);
  });

  test("never returns a password hash", async () => {
    const { body } = await app.post(
      "/api/v1/auth/register",
      { email: "hash@novagpt.test", password: PASSWORD },
      { anonymous: true }
    );
    const json = JSON.stringify(body);
    assert.ok(!/argon2|\$test\$|passwordHash/i.test(json), json);
  });

  test("refuses a duplicate email", async () => {
    const payload = { email: "dupe@novagpt.test", password: PASSWORD };
    await app.post("/api/v1/auth/register", payload, { anonymous: true });
    const { status, body } = await app.post("/api/v1/auth/register", payload, { anonymous: true });

    assert.equal(status, 409);
    assert.equal(body.error.kind, "conflict");
  });

  test("treats differently-cased addresses as one account", async () => {
    await app.post(
      "/api/v1/auth/register",
      { email: "Case@novagpt.test", password: PASSWORD },
      { anonymous: true }
    );
    const { status } = await app.post(
      "/api/v1/auth/register",
      { email: "case@NOVAGPT.test", password: PASSWORD },
      { anonymous: true }
    );
    assert.equal(status, 409, "otherwise one of the two accounts is unreachable");
  });

  test("rejects a short password before it reaches the hasher", async () => {
    const { status, body } = await app.post(
      "/api/v1/auth/register",
      { email: "weak@novagpt.test", password: "short" },
      { anonymous: true }
    );
    assert.equal(status, 400);
    assert.equal(body.error.kind, "validation");
  });

  test("rejects an object where a string is expected", async () => {
    // The NoSQL injection vector (T10): `{"$ne": null}` in place of a string.
    const { status } = await app.post(
      "/api/v1/auth/login",
      { email: { $ne: null }, password: { $ne: null } },
      { anonymous: true }
    );
    assert.equal(status, 400);
  });
});

describe("auth API — login", () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.post(
      "/api/v1/auth/register",
      { email: "user@novagpt.test", password: PASSWORD },
      { anonymous: true }
    );
  });
  after(() => app.close());

  test("signs in with the right password", async () => {
    const { status, body } = await app.post(
      "/api/v1/auth/login",
      { email: "user@novagpt.test", password: PASSWORD },
      { anonymous: true }
    );
    assert.equal(status, 200);
    assert.ok(body.data.accessToken);
  });

  test("an unknown account and a wrong password are indistinguishable", async () => {
    // Anything else is an enumeration oracle: an attacker who can tell them
    // apart gets a validated address list for free (T9).
    const wrong = await app.post(
      "/api/v1/auth/login",
      { email: "user@novagpt.test", password: "wrong-but-long-enough" },
      { anonymous: true }
    );
    const unknown = await app.post(
      "/api/v1/auth/login",
      { email: "nobody@novagpt.test", password: "wrong-but-long-enough" },
      { anonymous: true }
    );

    assert.equal(wrong.status, unknown.status);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
    assert.equal(wrong.body.error.kind, "unauthenticated");
  });

  test("locks the account after repeated failures, and says for how long", async () => {
    const app2 = await startApp({ config: { auth: lockoutConfig() } });
    try {
      await app2.post(
        "/api/v1/auth/register",
        { email: "target@novagpt.test", password: PASSWORD },
        { anonymous: true }
      );

      for (let i = 0; i < 3; i += 1) {
        await app2.post(
          "/api/v1/auth/login",
          { email: "target@novagpt.test", password: "definitely-wrong-here" },
          { anonymous: true }
        );
      }

      const locked = await app2.post(
        "/api/v1/auth/login",
        { email: "target@novagpt.test", password: PASSWORD },
        { anonymous: true }
      );

      assert.equal(locked.status, 429, "the right password must not bypass the lock");
      assert.ok(Number(locked.response.headers.get("retry-after")) > 0);
    } finally {
      await app2.close();
    }
  });

  test("records every outcome in the audit log, including the failures", async () => {
    // A credential-stuffing campaign that leaves no trace is one nobody sees.
    const app2 = await startApp();
    try {
      await app2.post(
        "/api/v1/auth/register",
        { email: "audited@novagpt.test", password: PASSWORD },
        { anonymous: true }
      );
      await app2.post(
        "/api/v1/auth/login",
        { email: "audited@novagpt.test", password: "wrong-but-long-enough" },
        { anonymous: true }
      );

      const failures = app2.audit.find("auth.login").filter((e) => e.outcome === "failure");
      assert.equal(failures.length, 1);
      assert.ok(!JSON.stringify(app2.audit.entries).includes(PASSWORD), "never the password");
    } finally {
      await app2.close();
    }
  });
});

describe("auth API — session lifetime", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  const registerAndGetCookie = async (email) => {
    const { response, body } = await app.post(
      "/api/v1/auth/register",
      { email, password: PASSWORD },
      { anonymous: true }
    );
    return { cookie: refreshCookie(response), token: body.data.accessToken };
  };

  test("refresh rotates the token", async () => {
    const { cookie } = await registerAndGetCookie("rotate@novagpt.test");

    const first = await app.post("/api/v1/auth/refresh", {}, {
      anonymous: true,
      headers: { Cookie: cookie },
    });

    assert.equal(first.status, 200);
    assert.notEqual(refreshCookie(first.response), cookie, "a refresh must mint a new token");
  });

  test("replaying a rotated token kills the whole family", async () => {
    // Reuse proves the family is compromised. Revoking only the replayed token
    // would leave the thief's *next* token working
    // (docs/backend/10-security.md#authentication).
    const { cookie } = await registerAndGetCookie("reuse@novagpt.test");

    const rotated = await app.post("/api/v1/auth/refresh", {}, {
      anonymous: true,
      headers: { Cookie: cookie },
    });
    const successor = refreshCookie(rotated.response);

    const replay = await app.post("/api/v1/auth/refresh", {}, {
      anonymous: true,
      headers: { Cookie: cookie },
    });
    assert.equal(replay.status, 401);

    const afterwards = await app.post("/api/v1/auth/refresh", {}, {
      anonymous: true,
      headers: { Cookie: successor },
    });
    assert.equal(afterwards.status, 401, "the successor must die with the family");
  });

  test("logout revokes the access token immediately", async () => {
    const { token, cookie } = await registerAndGetCookie("logout@novagpt.test");

    assert.equal((await app.json("/api/v1/auth/me", { token })).status, 200);
    await app.post("/api/v1/auth/logout", {}, { token, headers: { Cookie: cookie } });

    // Without the denylist this would keep working for the rest of the access
    // token's lifetime.
    assert.equal((await app.json("/api/v1/auth/me", { token })).status, 401);
  });

  test("logout clears the cookie even for a caller who was not signed in", async () => {
    const { response } = await app.post("/api/v1/auth/logout", {}, { anonymous: true });
    assert.match(response.headers.get("set-cookie") ?? "", /nova_refresh=;.*Max-Age=0/);
  });

  test("changing the password ends every other session", async () => {
    const { token, cookie } = await registerAndGetCookie("change@novagpt.test");

    const changed = await app.post(
      "/api/v1/auth/password",
      { currentPassword: PASSWORD, newPassword: "a-different-long-passphrase" },
      { token }
    );
    assert.equal(changed.status, 200);

    // A user changing their password is trying to evict someone; leaving the
    // old refresh token alive for 30 days makes the action cosmetic.
    const stale = await app.post("/api/v1/auth/refresh", {}, {
      anonymous: true,
      headers: { Cookie: cookie },
    });
    assert.equal(stale.status, 401);

    // The tab that made the change is handed a fresh pair.
    assert.equal((await app.json("/api/v1/auth/me", { token: changed.body.data.accessToken })).status, 200);
  });

  test("refuses a password change without the current password", async () => {
    const { token } = await registerAndGetCookie("nochange@novagpt.test");
    const { status } = await app.post(
      "/api/v1/auth/password",
      { currentPassword: "not-the-right-one", newPassword: "another-long-passphrase" },
      { token }
    );
    assert.equal(status, 401);
  });
});

describe("auth API — token handling", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("a refresh token is not accepted as an access token", async () => {
    // Without the `type` claim check, a refresh token is a perfectly valid
    // signed token — a 30-day bearer credential in the Authorization header.
    const { user } = await app.principal();
    const issued = await app.tokenService.issue(user);

    const { status } = await app.json("/api/v1/auth/me", { token: issued.refreshToken });
    assert.equal(status, 401);
  });

  test("a garbage token is refused, not crashed on", async () => {
    for (const token of ["abc", "a.b.c", "..", "x".repeat(500)]) {
      const { status } = await app.json("/api/v1/auth/me", { token });
      assert.equal(status, 401, token.slice(0, 10));
    }
  });

  test("a missing token gets a WWW-Authenticate challenge", async () => {
    const { response, status } = await app.json("/api/v1/auth/me", { anonymous: true });
    assert.equal(status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
  });

  test("a bad token does not break a public route", async () => {
    // Establishing identity and enforcing it are separate steps; the catalog
    // must serve a client holding an expired token.
    const { status } = await app.json("/api/v1/models", { token: "not-a-token" });
    assert.equal(status, 200);
  });
});

/* ------------------------------- helpers ------------------------------- */

/** The `Set-Cookie` value a browser would send back, or `""` if none was set. */
function refreshCookie(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /nova_refresh=([^;]*)/.exec(header);
  return match ? `nova_refresh=${match[1]}` : "";
}

/**
 * A complete auth config with a lock that trips after three failures, because
 * `testConfig` overrides replace the whole section rather than merging into it.
 */
function lockoutConfig() {
  return {
    required: true,
    allowRegistration: true,
    issuer: "novagpt-test",
    audience: "novagpt-api",
    accessTtlMs: 900_000,
    refreshTtlMs: 3_600_000,
    privateKey: null,
    publicKey: null,
    previousPublicKey: null,
    cookie: { name: "nova_refresh", domain: null, secure: false },
    password: { minLength: 12 },
    lockout: { threshold: 3, baseDelayMs: 60_000, maxDelayMs: 120_000 },
    encryptionKey: null,
  };
}
