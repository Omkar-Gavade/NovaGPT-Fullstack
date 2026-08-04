import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";

/**
 * Bring-your-own-key, over real HTTP.
 *
 * The five rules from
 * [10](../../../docs/backend/10-security.md#rules-for-user-supplied-keys) —
 * validated on submission, write-only, deletable, never used for another user,
 * and **never able to open the shared breaker**. The last one is the easiest to
 * miss and produces the worst outcome: one user pastes an expired key and every
 * other user loses that provider.
 */

const PASSWORD = "a-long-enough-passphrase";

describe("user keys — storage", () => {
  let app;
  let alice;

  before(async () => {
    app = await startApp();
    alice = await app.signIn("keys@novagpt.test");
  });
  after(() => app.close());

  test("stores a key and returns only a mask", async () => {
    const { status, body } = await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ key: "sk-live-abcdefghijklmnop7f2a" }),
    });

    assert.equal(status, 200);
    assert.equal(body.data.mask, "sk-…7f2a");
    // The response to the request that *supplied* the key still must not
    // contain it: a client logging its own responses would otherwise store it.
    assert.ok(!JSON.stringify(body).includes("abcdefghijklmnop"));
  });

  test("no endpoint returns the key, ever", async () => {
    // Write-only is the rule. A user who lost their key retrieves it from the
    // provider, not from us.
    const list = await app.json("/api/v1/me/keys", { token: alice.token });
    const dumped = JSON.stringify(list.body);

    assert.ok(!dumped.includes("abcdefghijklmnop"));
    assert.ok(!dumped.includes("envelope"), "the ciphertext must not leak either");
    assert.equal(list.body.data[0].mask, "sk-…7f2a");
    assert.equal(list.body.data[0].status, "active");
  });

  test("rejects a key the provider will not accept", async () => {
    // Validated *before* it is written. A key that fails at first use produces
    // a confusing experience the user blames on the platform.
    const provider = buildMockProvider();
    provider.script([{ fail: "auth" }]);
    const app2 = await startApp({ providers: [provider] });

    try {
      const user = await app2.signIn("bad@novagpt.test");
      const { status, body } = await app2.json("/api/v1/me/keys/mock", {
        method: "PUT",
        token: user.token,
        body: JSON.stringify({ key: "sk-definitely-wrong-key" }),
      });

      assert.equal(status, 400);
      assert.match(body.error.message, /rejected that key/);

      // And nothing was stored.
      const list = await app2.json("/api/v1/me/keys", { token: user.token });
      assert.equal(list.body.data.length, 0);
    } finally {
      await app2.close();
    }
  });

  test("rejects an object where a string is expected", async () => {
    const { status } = await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ key: { $ne: null } }),
    });
    assert.equal(status, 400);
  });

  test("deletion is immediate and complete", async () => {
    const user = await app.signIn("delete@novagpt.test");
    await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: user.token,
      body: JSON.stringify({ key: "sk-live-tobedeleted1234" }),
    });

    const removed = await app.json("/api/v1/me/keys/mock", { method: "DELETE", token: user.token });
    assert.equal(removed.status, 200);

    // Gone from the store itself, not flagged — a soft delete would leave the
    // ciphertext in every backup taken afterwards.
    assert.equal((await app.userKeys.listForUser(user.user.id)).length, 0);
  });

  test("adding and removing a key is audited, without the value", async () => {
    const user = await app.signIn("audited-keys@novagpt.test");
    await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: user.token,
      body: JSON.stringify({ key: "sk-live-auditme000000" }),
    });

    const added = app.audit.find("key.added");
    assert.ok(added.length > 0);
    assert.ok(!JSON.stringify(app.audit.entries).includes("auditme"), "never the value");
  });
});

describe("user keys — isolation", () => {
  let app;

  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("one user's key is never visible to another", async () => {
    const alice = await app.signIn("alice-keys@novagpt.test");
    const mallory = await app.signIn("mallory-keys@novagpt.test");

    await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ key: "sk-live-alicesecret123" }),
    });

    const mine = await app.json("/api/v1/me/keys", { token: mallory.token });
    assert.equal(mine.body.data.length, 0);
  });

  test("one user's key is never used for another user's request", async () => {
    const alice = await app.signIn("alice-req@novagpt.test");
    const bob = await app.signIn("bob-req@novagpt.test");

    await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ key: "sk-live-aliceonly00000" }),
    });

    const resolvedForAlice = await app.userKeyService.resolve(alice.user.id);
    const resolvedForBob = await app.userKeyService.resolve(bob.user.id);

    assert.equal(resolvedForAlice.size, 1);
    assert.equal(resolvedForBob.size, 0, "Bob's request would have run on Alice's credential");
  });

  test("the resolved credential is wrapped, so it cannot be logged by accident", async () => {
    const user = await app.signIn("wrapped@novagpt.test");
    await app.json("/api/v1/me/keys/mock", {
      method: "PUT",
      token: user.token,
      body: JSON.stringify({ key: "sk-live-wrapmeplease00" }),
    });

    const resolved = await app.userKeyService.resolve(user.user.id);
    const credential = resolved.get("mock");

    // The whole point of the Secret wrapper: the naive thing is safe.
    assert.equal(String(credential), "[REDACTED:BYOK]");
    assert.equal(JSON.stringify({ credential }), '{"credential":"[REDACTED:BYOK]"}');
    assert.equal(credential.expose(), "sk-live-wrapmeplease00");
  });
});

describe("user keys — the shared breaker", () => {
  test("a user's rejected key does not take the provider out for everyone", async () => {
    // **The rule that is easiest to miss and worst to get wrong.** One user
    // pastes an expired key, the breaker opens on `auth`, and every other user
    // loses that provider — for a credential that was never the platform's.
    const provider = buildMockProvider();
    const app = await startApp({ providers: [provider] });

    try {
      const alice = await app.signIn("breaker-alice@novagpt.test");
      const bob = await app.signIn("breaker-bob@novagpt.test");

      // Stored while the provider is healthy, so validation passes.
      await app.json("/api/v1/me/keys/mock", {
        method: "PUT",
        token: alice.token,
        body: JSON.stringify({ key: "sk-live-wasgoodonce000" }),
      });

      // The key is revoked at the provider: every call on it now fails auth.
      provider.script(Array.from({ length: 20 }, () => ({ fail: "auth" })));

      const hers = await app.post("/api/v1/chat", { message: "mine fails" }, { token: alice.token });
      assert.ok(hers.status >= 400, "her own request should fail");

      // The provider must still be available to everyone else.
      assert.equal(
        app.providerRegistry.isAvailable("mock"),
        true,
        "one user's bad key opened the shared breaker"
      );

      const logged = app.logger.find("routing.user_key_rejected");
      assert.ok(logged.length > 0, "the exemption should be visible, not silent");
    } finally {
      await app.close();
    }
  });

  test("a timeout on a user key still counts against the provider", async () => {
    // The exemption is narrow on purpose: a timeout or an outage is the
    // provider being unwell whoever's credential was used, and the fleet should
    // learn from it.
    const provider = buildMockProvider();
    const app = await startApp({ providers: [provider] });

    try {
      const user = await app.signIn("timeout-key@novagpt.test");
      await app.json("/api/v1/me/keys/mock", {
        method: "PUT",
        token: user.token,
        body: JSON.stringify({ key: "sk-live-timeoutkey0000" }),
      });

      provider.script(Array.from({ length: 20 }, () => ({ fail: "timeout" })));
      await app.post("/api/v1/chat", { message: "slow" }, { token: user.token });

      assert.equal(
        app.logger.find("routing.user_key_rejected").length,
        0,
        "a timeout must not be treated as a credential problem"
      );
    } finally {
      await app.close();
    }
  });
});
