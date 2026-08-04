import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";

/**
 * Rate limiting, over real HTTP.
 *
 * The arithmetic is unit-tested; what this file proves is that the rules are
 * actually *mounted*, that the right subject is counted, and that the failure
 * modes differ between chat and authentication
 * (docs/backend/10-security.md#rate-limiting).
 */

const tight = (overrides) => ({
  anonymousPerMinute: 100_000,
  authPerMinute: 100_000,
  chatPerMinute: 100_000,
  chatPerHour: 100_000,
  ...overrides,
});

describe("rate limiting over HTTP", () => {
  test("refuses chat past the per-user limit, with a Retry-After", async () => {
    const app = await startApp({ config: { rateLimit: tight({ chatPerMinute: 2 }) } });
    try {
      assert.equal((await app.post("/api/v1/chat", { message: "one" })).status, 200);
      assert.equal((await app.post("/api/v1/chat", { message: "two" })).status, 200);

      const refused = await app.post("/api/v1/chat", { message: "three" });
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.kind, "rate_limited");
      assert.ok(Number(refused.response.headers.get("retry-after")) > 0);
      assert.equal(refused.response.headers.get("ratelimit-limit"), "2");
    } finally {
      await app.close();
    }
  });

  test("counts each user separately", async () => {
    // Twenty requests of 400K tokens cost far more quota than twenty of 400,
    // but neither should ever be charged to a different account.
    const app = await startApp({ config: { rateLimit: tight({ chatPerMinute: 1 }) } });
    try {
      const alice = await app.signIn("a@novagpt.test");
      const bob = await app.signIn("b@novagpt.test");

      assert.equal((await app.post("/api/v1/chat", { message: "hi" }, { token: alice.token })).status, 200);
      assert.equal((await app.post("/api/v1/chat", { message: "hi" }, { token: alice.token })).status, 429);
      assert.equal((await app.post("/api/v1/chat", { message: "hi" }, { token: bob.token })).status, 200);
    } finally {
      await app.close();
    }
  });

  test("a rule applies to its own routes and no others", async () => {
    // Mounting a limiter with `router.use` also runs it for requests that fall
    // through to a later controller. That charged every chat call against the
    // anonymous catalog budget — invisible until the wrong rule refused a
    // request the user had every right to make.
    const app = await startApp({ config: { rateLimit: tight({ anonymousPerMinute: 2 }) } });
    try {
      for (let i = 0; i < 3; i += 1) await app.json("/api/v1/models");
      assert.equal((await app.json("/api/v1/models")).status, 429);

      assert.equal((await app.post("/api/v1/chat", { message: "unaffected" })).status, 200);
      assert.equal((await app.json("/api/v1/threads")).status, 200);
    } finally {
      await app.close();
    }
  });

  test("stopping a stream is never rate limited", async () => {
    // A user who has hit the limit is exactly the user most likely to want to
    // cancel something, and stopping reduces load rather than adding it.
    const app = await startApp({ config: { rateLimit: tight({ chatPerMinute: 1 }) } });
    try {
      await app.post("/api/v1/chat", { message: "one" });
      assert.equal((await app.post("/api/v1/chat", { message: "two" })).status, 429);

      const stop = await app.post("/api/v1/chat/stop", { streamId: "whatever" });
      assert.equal(stop.status, 200);
    } finally {
      await app.close();
    }
  });

  test("limits sign-in attempts per IP", async () => {
    const app = await startApp({ config: { rateLimit: tight({ authPerMinute: 3 }) } });
    try {
      const attempt = () =>
        app.post(
          "/api/v1/auth/login",
          { email: "nobody@novagpt.test", password: "wrong-but-long-enough" },
          { anonymous: true }
        );

      for (let i = 0; i < 3; i += 1) await attempt();
      const refused = await attempt();

      // Credential stuffing is defended per IP, before the account-level
      // lockout, because a stuffing run targets many accounts from one source.
      assert.equal(refused.status, 429);
    } finally {
      await app.close();
    }
  });

  test("chat survives an unavailable counter; sign-in does not", async () => {
    // The asymmetry is the decision. Refusing all chat to protect a quota is a
    // self-inflicted outage worse than the abuse it prevents; refusing logins
    // for a few minutes beats permitting unlimited credential stuffing.
    const app = await startApp();
    try {
      const user = await app.signIn("degraded@novagpt.test");

      // Break the counter the way a Redis outage does: reads and increments
      // report "unavailable" rather than a plausible number.
      app.cache.increment = async () => null;
      app.cache.get = async () => null;

      const chat = await app.post("/api/v1/chat", { message: "still working?" }, { token: user.token });
      assert.equal(chat.status, 200);

      const login = await app.post(
        "/api/v1/auth/login",
        { email: "degraded@novagpt.test", password: "a-long-enough-passphrase" },
        { anonymous: true }
      );
      assert.equal(login.status, 429);
      assert.match(login.body.error.message, /temporarily throttled/);
    } finally {
      await app.close();
    }
  });

  test("a limiter defect does not take down the route it protects", async () => {
    const app = await startApp();
    try {
      app.cache.increment = async () => {
        throw new Error("counter exploded");
      };

      const { status } = await app.post("/api/v1/chat", { message: "hello" });
      assert.equal(status, 200, "telemetry and limits must not break the request");
    } finally {
      await app.close();
    }
  });
});
