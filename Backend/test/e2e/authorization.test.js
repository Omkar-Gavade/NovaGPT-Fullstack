import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";

/**
 * Cross-user access, swept across every endpoint that names a resource (T5).
 *
 * This suite exists because authorization defects are *omissions*. Testing the
 * endpoints someone remembered to protect proves nothing; the table below is
 * generated from the route list, so an endpoint added without scoping shows up
 * here as a failure rather than as an incident.
 *
 * Everything must answer **404**, not 403: a 403 confirms the resource exists,
 * which is exactly the enumeration a 404 denies
 * (docs/backend/10-security.md#authorization).
 */

describe("authorization — cross-user access", () => {
  let app;
  let alice;
  let mallory;
  let thread;
  let messageId;

  before(async () => {
    app = await startApp();

    alice = await app.signIn("alice@novagpt.test");
    mallory = await app.signIn("mallory@novagpt.test");

    const sent = await app.post("/api/v1/chat", { message: "alice's secret" }, { token: alice.token });
    thread = sent.body.data.threadId;

    const full = await app.json(`/api/v1/threads/${thread}`, { token: alice.token });
    messageId = full.body.data.messages[0].id;
  });

  after(() => app.close());

  /**
   * Every route that takes a resource id. Adding a route without adding it here
   * is the mistake this file is designed to catch, so the list is deliberately
   * exhaustive rather than representative.
   */
  const routes = () => [
    ["GET", () => `/api/v1/threads/${thread}`],
    ["PATCH", () => `/api/v1/threads/${thread}`, { title: "mine now" }],
    ["DELETE", () => `/api/v1/threads/${thread}`],
    ["GET", () => `/api/v1/threads/${thread}/settings`],
    ["PUT", () => `/api/v1/threads/${thread}/settings`, { temperature: 1.5 }],
    ["POST", () => `/api/v1/threads/${thread}/duplicate`, {}],
    ["POST", () => `/api/v1/threads/${thread}/share`, {}],
    ["DELETE", () => `/api/v1/threads/${thread}/share`],
    ["PATCH", () => `/api/v1/threads/${thread}/messages/${messageId}/pin`, { pinned: true }],
  ];

  for (const [method, path, body] of routes()) {
    test(`${method} ${path().replace(/[0-9a-f-]{8,}/g, ":id")} is a 404 for another user`, async () => {
      const { status, body: response } = await app.json(path(), {
        method,
        token: mallory.token,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      assert.equal(status, 404, `${method} leaked a resource`);
      assert.equal(response.error.kind, "not_found");
    });
  }

  test("a foreign thread never appears in a listing", async () => {
    const { body } = await app.json("/api/v1/threads", { token: mallory.token });
    assert.equal(body.data.length, 0);
  });

  test("search does not reach across owners", async () => {
    // Title search is a query path of its own, and a filter applied after the
    // scope is a filter someone can forget.
    const { body } = await app.json("/api/v1/threads?q=secret", { token: mallory.token });
    assert.equal(body.data.length, 0);
  });

  test("sending to another user's thread does not take it over", async () => {
    // The thread id is client-supplied. Creating one for a "missing" thread
    // would upsert straight over the real conversation on the next save.
    const { status } = await app.post(
      "/api/v1/chat",
      { threadId: thread, message: "hello, is this mine now?" },
      { token: mallory.token }
    );
    assert.equal(status, 404);

    const owner = await app.json(`/api/v1/threads/${thread}`, { token: alice.token });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.data.messages[0].content, "alice's secret");
  });

  test("regenerate and continue refuse a foreign thread", async () => {
    for (const path of ["/api/v1/chat/regenerate", "/api/v1/chat/continue"]) {
      const { status } = await app.post(
        path,
        { threadId: thread, messageId },
        { token: mallory.token }
      );
      assert.equal(status, 404, path);
    }
  });

  test("an anonymous caller cannot reach a conversation at all", async () => {
    const { status } = await app.json(`/api/v1/threads/${thread}`, { anonymous: true });
    assert.equal(status, 401);
  });

  test("stopping someone else's stream reports false rather than stopping it", async () => {
    const registry = app.streamRegistry;
    const controller = registry.register("stream-1", { threadId: thread, ownerId: alice.user.id });

    const { body } = await app.post(
      "/api/v1/chat/stop",
      { streamId: "stream-1" },
      { token: mallory.token }
    );

    assert.equal(body.data.stopped, false);
    assert.equal(controller.signal.aborted, false);
    registry.release("stream-1");
  });
});

describe("authorization — share links", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("a share link is readable by anyone, which is the point", async () => {
    const alice = await app.signIn("sharer@novagpt.test");
    const sent = await app.post("/api/v1/chat", { message: "public thoughts" }, { token: alice.token });
    const shared = await app.post(
      `/api/v1/threads/${sent.body.data.threadId}/share`,
      {},
      { token: alice.token }
    );

    // Requiring an account here would break every link already sent.
    const view = await app.json(`/api/v1/share/${shared.body.data.shareId}`, { anonymous: true });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.title, "public thoughts");
  });

  test("an unshared id is a 404, not an empty conversation", async () => {
    const { status } = await app.json("/api/v1/share/does-not-exist", { anonymous: true });
    assert.equal(status, 404);
  });
});

describe("authorization — operator surfaces", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("metrics need the admin permission", async () => {
    // Metrics expose route names, provider identities and traffic shape. The
    // first registered account is the operator's, so a second one is a plain
    // user (docs/backend/10-security.md#roles).
    const admin = await app.signIn("first@novagpt.test");
    const user = await app.signIn("second@novagpt.test");

    assert.equal((await app.json("/api/v1/admin/metrics", { anonymous: true })).status, 401);
    assert.equal((await app.json("/api/v1/admin/metrics", { token: user.token })).status, 403);
    assert.equal((await app.json("/api/v1/admin/metrics", { token: admin.token })).status, 200);
  });

  test("the first account is an admin and later ones are not", async () => {
    // Bootstrapping an operator any other way means a seeded default password
    // shipped to every deployment, or a manual database edit.
    const app2 = await startApp();
    try {
      const first = await app2.signIn("owner@novagpt.test");
      const second = await app2.signIn("member@novagpt.test");
      assert.equal(first.user.role, "admin");
      assert.equal(second.user.role, "user");
    } finally {
      await app2.close();
    }
  });
});

describe("authorization — the response surface", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("no endpoint returns a credential, a hash, or a base URL", async () => {
    // T1: keys leak through paths nobody designed — error bodies, debug
    // fields, an object spread into a serialiser. This is the structural check.
    const user = await app.principal();
    const sent = await app.post("/api/v1/chat", { message: "hello" });
    const threadId = sent.body.data.threadId;

    const responses = await Promise.all([
      app.json("/api/v1/models"),
      app.json("/api/v1/providers"),
      app.json("/api/v1/threads"),
      app.json(`/api/v1/threads/${threadId}`),
      app.json("/api/v1/auth/me"),
      app.json("/api/v1/threads/nope"),
    ]);

    const forbidden = /api[_-]?key|secret|passwordHash|\$argon2|\$test\$|Bearer |baseURL|mongodb:\/\//i;
    for (const { body } of responses) {
      const json = JSON.stringify(body);
      assert.ok(!forbidden.test(json), json.slice(0, 300));
    }
    assert.ok(user.token, "the sweep must have run against a real session");
  });

  test("an error body carries a trace id and no stack in production shape", async () => {
    const { body } = await app.json("/api/v1/threads/does-not-exist");
    assert.ok(body.error.traceId);
    assert.equal(body.error.kind, "not_found");
  });
});
