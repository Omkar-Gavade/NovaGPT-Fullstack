import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SystemClock, FakeClock } from "../../src/infrastructure/system/SystemClock.js";

describe("SystemClock", () => {
  test("reports the current time", () => {
    const clock = new SystemClock();
    assert.ok(Math.abs(clock.now() - Date.now()) < 50);
    assert.ok(clock.date() instanceof Date);
  });

  test("sleeps for approximately the requested duration", async () => {
    const clock = new SystemClock();
    const started = clock.now();
    await clock.sleep(20);
    assert.ok(clock.now() - started >= 15);
  });

  test("rejects when the signal aborts mid-sleep", async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(() => clock.sleep(5000, controller.signal), { name: "AbortError" });
  });

  test("rejects immediately for an already-aborted signal", async () => {
    const clock = new SystemClock();
    await assert.rejects(() => clock.sleep(10, AbortSignal.abort()), { name: "AbortError" });
  });
});

describe("FakeClock", () => {
  test("advances only when told to", () => {
    const clock = new FakeClock(1000);
    assert.equal(clock.now(), 1000);
    clock.advance(500);
    assert.equal(clock.now(), 1500);
  });

  test("makes a long sleep instantaneous", async () => {
    // This is why time is a port: asserting a 15-minute cooldown must not
    // take 15 minutes, or need fake timers patched over globals.
    const clock = new FakeClock(0);
    const realStart = Date.now();
    await clock.sleep(15 * 60_000);
    assert.equal(clock.now(), 900_000);
    assert.ok(Date.now() - realStart < 100);
  });
});
