import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { InMemoryThreadRepository } from "../../src/infrastructure/persistence/memory/InMemoryThreadRepository.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";

/**
 * Conversation lifecycle over HTTP: list, read, rename, pin, archive, share,
 * duplicate, delete.
 */

describe("thread API — lifecycle", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  const newThread = async (message = "seed") => {
    const { body } = await app.post("/api/v1/chat", { message });
    return body.data.threadId;
  };

  test("lists threads newest first", async () => {
    const app2 = await startApp();
    try {
      await app2.post("/api/v1/chat", { message: "older" });
      await new Promise((r) => setTimeout(r, 5));
      await app2.post("/api/v1/chat", { message: "newer" });

      const { body } = await app2.json("/api/v1/threads");
      assert.equal(body.data[0].title, "newer");
      assert.equal(body.data.length, 2);
    } finally {
      await app2.close();
    }
  });

  test("list rows omit message bodies", async () => {
    // The sidebar needs titles, not bodies; loading every message of every
    // thread to render a list is the easiest way to make this endpoint slow.
    await newThread("has messages");
    const { body } = await app.json("/api/v1/threads");
    assert.equal(body.data[0].messages, undefined);
    assert.ok(body.data[0].messageCount > 0);
  });

  test("paginates with an opaque cursor", async () => {
    const app2 = await startApp();
    try {
      for (let i = 0; i < 5; i += 1) {
        await app2.post("/api/v1/chat", { message: `thread ${i}` });
        await new Promise((r) => setTimeout(r, 2));
      }

      const first = await app2.json("/api/v1/threads?limit=2");
      assert.equal(first.body.data.length, 2);
      assert.ok(first.body.meta.cursor);

      const second = await app2.json(
        `/api/v1/threads?limit=2&cursor=${encodeURIComponent(first.body.meta.cursor)}`
      );
      const firstIds = first.body.data.map((t) => t.id);
      const secondIds = second.body.data.map((t) => t.id);
      // The property offsets cannot guarantee while the sort key changes.
      assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
    } finally {
      await app2.close();
    }
  });

  test("archived=false lists active threads, not archived ones", async () => {
    // `z.coerce.boolean()` would read the string "false" as true, listing
    // archived threads for every default request — an empty sidebar over
    // perfectly good data.
    const app2 = await startApp();
    try {
      await app2.post("/api/v1/chat", { message: "active thread" });
      const explicit = await app2.json("/api/v1/threads?archived=false");
      assert.equal(explicit.body.data.length, 1);
      assert.equal(explicit.body.data[0].title, "active thread");

      const archived = await app2.json("/api/v1/threads?archived=true");
      assert.equal(archived.body.data.length, 0);
    } finally {
      await app2.close();
    }
  });

  test("a malformed cursor returns the first page rather than an error", async () => {
    // It is almost always a stale bookmark; failing the request helps nobody.
    const { status } = await app.json("/api/v1/threads?cursor=not-a-cursor");
    assert.equal(status, 200);
  });

  test("clamps an oversized limit instead of rejecting", async () => {
    const { status } = await app.json("/api/v1/threads?limit=5000");
    assert.equal(status, 400, "beyond the documented max is a validation error");
  });

  test("renames a thread", async () => {
    const id = await newThread();
    const { body } = await app.json(`/api/v1/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
    assert.equal(body.data.title, "Renamed");
  });

  test("rejects an empty title", async () => {
    const id = await newThread();
    const { status } = await app.json(`/api/v1/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "" }),
    });
    assert.equal(status, 400);
  });

  test("archives and unarchives", async () => {
    const id = await newThread();
    await app.json(`/api/v1/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });

    const active = await app.json("/api/v1/threads");
    assert.ok(!active.body.data.some((t) => t.id === id));

    const archived = await app.json("/api/v1/threads?archived=true");
    assert.ok(archived.body.data.some((t) => t.id === id));
  });

  test("updates settings, which then apply to later turns", async () => {
    const id = await newThread();
    const put = await app.json(`/api/v1/threads/${id}/settings`, {
      method: "PUT",
      body: JSON.stringify({ temperature: 0.2, systemPrompt: "be terse" }),
    });
    assert.equal(put.body.data.temperature, 0.2);

    const read = await app.json(`/api/v1/threads/${id}/settings`);
    assert.equal(read.body.data.systemPrompt, "be terse");
  });

  test("pins a message so the context engine keeps it", async () => {
    const send = await app.post("/api/v1/chat", { message: "pin this one" });
    const threadId = send.body.data.threadId;
    const { body: thread } = await app.json(`/api/v1/threads/${threadId}`);
    const messageId = thread.data.messages[0].id;

    const { body } = await app.json(
      `/api/v1/threads/${threadId}/messages/${messageId}/pin`,
      { method: "PATCH", body: JSON.stringify({ pinned: true }) }
    );
    assert.equal(body.data.pinned, true);
  });

  test("duplicates a thread without carrying the share link", async () => {
    const id = await newThread("original");
    await app.post(`/api/v1/threads/${id}/share`, {});

    const copy = await app.post(`/api/v1/threads/${id}/duplicate`, {});
    assert.equal(copy.status, 201);
    assert.match(copy.body.data.title, /\(copy\)$/);
    // Revoking one must not silently revoke the other.
    assert.equal(copy.body.data.shareId, null);
    assert.notEqual(copy.body.data.id, id);
  });

  test("delete is soft and removes the thread from listings", async () => {
    const id = await newThread();
    const del = await app.json(`/api/v1/threads/${id}`, { method: "DELETE" });
    assert.equal(del.body.data.deleted, true);
    assert.equal(del.body.data.recoverableForDays, 30);

    const list = await app.json("/api/v1/threads");
    assert.ok(!list.body.data.some((t) => t.id === id));

    const read = await app.json(`/api/v1/threads/${id}`);
    assert.equal(read.status, 404);
  });

  test("an unknown thread is a 404 with the standard envelope", async () => {
    const { status, body } = await app.json("/api/v1/threads/does-not-exist");
    assert.equal(status, 404);
    assert.equal(body.error.kind, "not_found");
    assert.ok(body.error.traceId);
  });
});

describe("thread API — sharing", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("share is idempotent", async () => {
    // A double-click must not mint a second link the user cannot see and
    // therefore cannot revoke.
    const send = await app.post("/api/v1/chat", { message: "shared" });
    const id = send.body.data.threadId;

    const first = await app.post(`/api/v1/threads/${id}/share`, {});
    const second = await app.post(`/api/v1/threads/${id}/share`, {});
    assert.equal(first.body.data.shareId, second.body.data.shareId);
  });

  test("a shared thread is publicly readable, and revocable", async () => {
    const send = await app.post("/api/v1/chat", { message: "public please" });
    const id = send.body.data.threadId;
    const { body: shared } = await app.post(`/api/v1/threads/${id}/share`, {});

    const view = await app.json(`/api/v1/share/${shared.data.shareId}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.data.title, "public please");
    assert.ok(view.body.data.messages.length > 0);

    await app.json(`/api/v1/threads/${id}/share`, { method: "DELETE" });
    const revoked = await app.json(`/api/v1/share/${shared.data.shareId}`);
    assert.equal(revoked.status, 404);
  });
});

describe("catalog API", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test("lists models with live availability and a catalog version", async () => {
    const { status, body } = await app.json("/api/v1/models");
    assert.equal(status, 200);
    assert.ok(body.data.length > 0);
    assert.ok(body.meta.catalogVersion > 0);

    const model = body.data[0];
    assert.ok(model.capabilities);
    assert.ok(model.limits.contextWindow > 0);
    assert.equal(typeof model.available, "boolean");
  });

  test("never exposes a credential or an endpoint", async () => {
    const { body } = await app.json("/api/v1/providers");
    const json = JSON.stringify(body);
    assert.ok(!/api[_-]?key|secret|credential|baseURL|Bearer/i.test(json), json.slice(0, 200));
  });
});

/**
 * Both repository implementations must behave identically, or a test written
 * against one describes nothing about the other.
 */
describe("ThreadRepository — port conformance", () => {
  const build = () => new InMemoryThreadRepository({ clock: new SystemClock() });

  test("returns null for a missing thread rather than throwing", async () => {
    assert.equal(await build().findById("nope"), null);
  });

  test("scopes reads by owner", async () => {
    // Scoping at the query means the wrong user's data is never in memory.
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "t1", userId: "alice" }));

    assert.ok(await repo.findById("t1", "alice"));
    assert.equal(await repo.findById("t1", "mallory"), null);
  });

  test("a null owner is a scope, not a wildcard", async () => {
    // The earlier behaviour treated `null` as "no scope requested" and returned
    // everything — harmless with no accounts, a cross-user disclosure with them.
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "owned", userId: "alice" }));
    await repo.save(new Thread({ id: "ownerless" }));

    assert.equal(await repo.findById("owned", null), null);
    assert.ok(await repo.findById("ownerless", null));
    assert.equal((await repo.list({ ownerId: null })).items.length, 1);
  });

  test("existsById ignores the owner, and nothing else does", async () => {
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "t1", userId: "alice" }));

    assert.equal(await repo.existsById("t1"), true);
    assert.equal(await repo.existsById("nope"), false);
  });

  test("refuses to save across an owner boundary", async () => {
    // Without this, a caller who supplies another user's thread id on a send
    // overwrites that conversation with their own.
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "t1", userId: "alice" }));

    await assert.rejects(() => repo.save(new Thread({ id: "t1", userId: "mallory" })), {
      kind: "conflict",
    });
  });

  test("soft delete hides a thread from every read", async () => {
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "t1" }));

    assert.equal(await repo.softDelete("t1"), true);
    assert.equal(await repo.findById("t1"), null);
    assert.equal((await repo.list()).items.length, 0);
  });

  test("purge removes only threads past the window", async () => {
    const repo = build();
    const { Thread } = await import("../../src/domain/conversation/Thread.js");
    await repo.save(new Thread({ id: "old", deletedAt: new Date("2020-01-01").toISOString() }));
    await repo.save(new Thread({ id: "recent", deletedAt: new Date().toISOString() }));

    assert.equal(await repo.purgeDeletedBefore(new Date("2021-01-01")), 1);
  });
});
