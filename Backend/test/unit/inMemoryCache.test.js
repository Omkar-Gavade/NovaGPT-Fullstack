import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCache } from "../../src/infrastructure/cache/memory/InMemoryCache.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";

function build(maxEntries) {
  const clock = new FakeClock(0);
  return { clock, cache: new InMemoryCache({ clock, maxEntries }) };
}

describe("InMemoryCache", () => {
  test("round-trips a value", async () => {
    const { cache } = build();
    await cache.set("k", { a: 1 });
    assert.deepEqual(await cache.get("k"), { a: 1 });
  });

  test("returns null for a missing key", async () => {
    assert.equal(await build().cache.get("nope"), null);
  });

  test("expires a value once its TTL elapses", async () => {
    const { cache, clock } = build();
    await cache.set("k", "v", 1000);
    clock.advance(999);
    assert.equal(await cache.get("k"), "v");
    clock.advance(2);
    assert.equal(await cache.get("k"), null);
  });

  test("keeps a value with no TTL indefinitely", async () => {
    const { cache, clock } = build();
    await cache.set("k", "v");
    clock.advance(10_000_000);
    assert.equal(await cache.get("k"), "v");
  });

  test("deletes a key", async () => {
    const { cache } = build();
    await cache.set("k", "v");
    await cache.del("k");
    assert.equal(await cache.get("k"), null);
  });

  test("increments from zero and returns the running count", async () => {
    const { cache } = build();
    assert.equal(await cache.increment("hits", 1000), 1);
    assert.equal(await cache.increment("hits", 1000), 2);
    assert.equal(await cache.increment("hits", 1000), 3);
  });

  test("does not extend the window on later increments", async () => {
    // Otherwise sustained traffic keeps pushing the expiry out and the counter
    // never resets, which silently converts a rate limit into a permanent ban.
    const { cache, clock } = build();
    await cache.increment("hits", 1000);
    clock.advance(600);
    await cache.increment("hits", 1000);
    clock.advance(500); // 1100ms since the first increment
    assert.equal(await cache.increment("hits", 1000), 1, "window should have reset");
  });

  test("bounds its size so it cannot exhaust the heap", async () => {
    const { cache } = build(10);
    for (let i = 0; i < 50; i += 1) await cache.set(`k${i}`, i);
    assert.ok(cache.store.size <= 10);
    // Oldest-first eviction: the most recent writes survive.
    assert.equal(await cache.get("k49"), 49);
  });

  test("reports itself healthy and identifies as the degraded implementation", async () => {
    const { cache } = build();
    assert.equal(cache.kind, "memory");
    assert.equal(await cache.isHealthy(), true);
    const probe = await cache.probe();
    assert.equal(probe.ok, true);
    assert.equal(probe.critical, false, "cache loss must not remove an instance from rotation");
  });

  test("clears on close", async () => {
    const { cache } = build();
    await cache.set("k", "v");
    await cache.close();
    assert.equal(await cache.get("k"), null);
  });
});
