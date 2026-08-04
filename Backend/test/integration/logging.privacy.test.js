import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider } from "../helpers/mockProvider.js";

/**
 * What must never reach the log pipeline.
 *
 * T1 and T13 rank above everything else in the threat model because they are
 * high impact *and* high likelihood, and because the mechanism is the same:
 * sensitive data ending up somewhere nobody designed, through a path nobody
 * thought of as "the security surface" (docs/backend/10-security.md).
 *
 * The harness runs its logger at `debug`, which is deliberately the worst case
 * — if a prompt leaks at any level, it leaks here.
 */

const SECRET_PROMPT = "my database password is hunter2 and the key is sk-live-abcdef";

describe("log privacy", () => {
  test("a prompt never reaches the logs by default", async () => {
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: SECRET_PROMPT });

      const dumped = JSON.stringify(app.logger.lines);
      assert.ok(!dumped.includes("hunter2"), "prompt content leaked into the logs");
      assert.ok(!dumped.includes("sk-live-abcdef"));
    } finally {
      await app.close();
    }
  });

  test("the completion never reaches the logs either", async () => {
    const provider = buildMockProvider({ defaultText: "the model said something private" });
    const app = await startApp({ providers: [provider] });
    try {
      await app.post("/api/v1/chat", { message: "hello" });
      assert.ok(!JSON.stringify(app.logger.lines).includes("something private"));
    } finally {
      await app.close();
    }
  });

  test("token counts are logged instead, which is the point", async () => {
    // "Log token counts, never text" is only a real substitute if the counts
    // are actually there.
    const app = await startApp();
    try {
      await app.post("/api/v1/chat", { message: "count me" });

      const [prepared] = app.logger.find("chat.prepared");
      assert.ok(prepared.promptTokens > 0);
      assert.equal(typeof prepared.trimmed, "number");
    } finally {
      await app.close();
    }
  });

  test("a stream's tokens never reach the logs", async () => {
    const app = await startApp();
    try {
      await app.sse("/api/v1/chat/stream", { message: SECRET_PROMPT });
      assert.ok(!JSON.stringify(app.logger.lines).includes("hunter2"));
    } finally {
      await app.close();
    }
  });

  test("content logging is opt-in, and then it is at debug only", async () => {
    // Some deployments genuinely need it. Making it a deliberate action rather
    // than a flag someone flips and forgets is the difference between a tool
    // and a liability.
    const app = await startApp({
      config: { log: { level: "silent", pretty: false, content: true } },
    });
    try {
      await app.post("/api/v1/chat", { message: SECRET_PROMPT });

      const [content] = app.logger.find("chat.prompt_content");
      assert.ok(content, "opting in must actually produce the content");
      assert.equal(content.level, "debug");
      assert.ok(JSON.stringify(content).includes("hunter2"));
    } finally {
      await app.close();
    }
  });

  test("no log line carries a credential, whatever the level", async () => {
    const app = await startApp();
    try {
      await app.post(
        "/api/v1/auth/register",
        { email: "leak@novagpt.test", password: "a-long-enough-passphrase" },
        { anonymous: true }
      );
      await app.post("/api/v1/chat", { message: "hello" });

      const dumped = JSON.stringify(app.logger.lines);
      assert.ok(!dumped.includes("a-long-enough-passphrase"), "a password reached the logs");
      assert.ok(!/\$argon2|\$test\$/.test(dumped), "a password hash reached the logs");
      // A signed token in a log line is a credential someone can replay.
      assert.ok(!/eyJhbGciOi/.test(dumped), "a JWT reached the logs");
    } finally {
      await app.close();
    }
  });
});
