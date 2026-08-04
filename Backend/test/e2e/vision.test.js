import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/appHarness.js";
import { buildMockProvider, mockDescriptor } from "../helpers/mockProvider.js";
import { Adapter } from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";
import { buildContent, withoutPayloads } from "../../src/domain/conversation/MessageContent.js";

/**
 * Vision, end to end.
 *
 * The acceptance criterion is specific: *a vision request routes only to
 * vision-capable models and fails over between them.* Both halves matter — the
 * first stops a request reaching a model that will reject it, and the second is
 * what makes a four-provider vision pool a pool rather than a list.
 *
 * **Verified against mocks, not against a real provider.** Only Gemini holds a
 * credential in this environment, so cross-provider vision failover cannot be
 * live-verified. The routing and normalisation are real; the providers are not.
 */

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]).toString("base64");

/** A provider whose models can be given any capability set. */
function provider(id, { vision = false, pdf = false } = {}) {
  const descriptor = new ProviderDescriptor({
    ...mockDescriptor,
    id,
    name: `Mock ${id}`,
    models: [
      {
        id: `${id}-model`,
        displayName: `${id} model`,
        capabilities: {
          streaming: true,
          json: true,
          ...(vision ? { vision: true } : {}),
          ...(pdf ? { pdf: true } : {}),
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          speed: 80,
        },
        tier: "free",
        costBand: "Free",
      },
    ],
  });

  return new Adapter({
    descriptor,
    models: descriptor.models.map((m) => new ModelDescriptor({ ...m, provider: id })),
    logger: silentLogger,
    clock: new SystemClock(),
    credential: new Secret("enabled", "MOCK_PROVIDER_ENABLED"),
  });
}

const imageMessage = { message: "what is in this image?", attachments: [{ type: "image", data: PNG_BASE64 }] };

describe("vision — routing", () => {
  test("routes only to a vision-capable model", async () => {
    // The text-only provider is faster and would otherwise win on ranking.
    const app = await startApp({
      providers: [provider("textonly"), provider("seeing", { vision: true })],
    });

    try {
      const { status, body } = await app.post("/api/v1/chat", imageMessage);

      assert.equal(status, 200);
      assert.equal(body.meta.provider, "seeing", "an image reached a text-only model");
    } finally {
      await app.close();
    }
  });

  test("fails over between vision providers", async () => {
    // A pool of one is not a pool. This is the half of the criterion that makes
    // the vision capability survive a provider outage.
    // Every attempt fails, not just the first: `outage` is retryable, so a
    // single scripted failure is absorbed by a same-provider retry and never
    // reaches the failover path this test is about.
    const first = provider("seeing-a", { vision: true });
    first.script(Array.from({ length: 20 }, () => ({ fail: "outage" })));

    const app = await startApp({
      providers: [first, provider("seeing-b", { vision: true }), provider("textonly")],
    });

    try {
      const { status, body } = await app.post("/api/v1/chat", imageMessage);

      assert.equal(status, 200);
      assert.equal(body.meta.provider, "seeing-b");
      // And it must never fall back to a model that cannot see. A failover that
      // silently drops the capability produces an answer about nothing.
      assert.notEqual(body.meta.provider, "textonly");
    } finally {
      await app.close();
    }
  });

  test("with no vision provider, the error names the capability", async () => {
    // Better than a provider-side rejection: the user learns their deployment
    // cannot do this, rather than seeing a 400 from an API they never called.
    const app = await startApp({ providers: [provider("textonly")] });

    try {
      const { status, body } = await app.post("/api/v1/chat", imageMessage);

      assert.equal(status, 422);
      assert.equal(body.error.kind, "unsupported_capability");
      assert.match(JSON.stringify(body.error), /vision/i);
    } finally {
      await app.close();
    }
  });

  test("a PDF routes to a pdf-capable model, not merely a vision one", async () => {
    // Distinct capabilities: most vision models cannot read a PDF natively, and
    // treating them as the same axis sends a document to a model that will
    // reject it.
    const app = await startApp({
      providers: [provider("seeing", { vision: true }), provider("reading", { pdf: true })],
    });

    try {
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]).toString("base64");
      const { status, body } = await app.post("/api/v1/chat", {
        message: "summarise this",
        attachments: [{ type: "pdf", data: pdf }],
      });

      assert.equal(status, 200);
      assert.equal(body.meta.provider, "reading");
    } finally {
      await app.close();
    }
  });

  test("a mislabelled attachment cannot route around the capability filter", async () => {
    // The client claims `type: "pdf"`; the bytes are a PNG. Requirements are
    // derived from the sniffed content, so the claim is irrelevant.
    const app = await startApp({
      providers: [provider("seeing", { vision: true }), provider("reading", { pdf: true })],
    });

    try {
      const { body } = await app.post("/api/v1/chat", {
        message: "what is this?",
        attachments: [{ type: "pdf", data: PNG_BASE64 }],
      });

      assert.equal(body.meta.provider, "seeing", "routing trusted the client's label over the bytes");
    } finally {
      await app.close();
    }
  });
});

describe("vision — persistence", () => {
  test("the stored thread keeps the shape but not the bytes", async () => {
    // Storing base64 would push a conversation past the BSON limit within a few
    // turns, and the context engine would re-upload the same image to the
    // provider on every subsequent message.
    const app = await startApp({ providers: [provider("seeing", { vision: true })] });

    try {
      const sent = await app.post("/api/v1/chat", imageMessage);
      const { body } = await app.json(`/api/v1/threads/${sent.body.data.threadId}`);

      const stored = JSON.stringify(body.data.messages[0]);
      assert.ok(!stored.includes(PNG_BASE64), "the image payload was written to the thread");
      assert.match(stored, /image/, "the fact that an image was sent must survive");
    } finally {
      await app.close();
    }
  });
});

describe("multimodal content", () => {
  test("stays a plain string when there is nothing but text", () => {
    // The overwhelmingly common case. Every existing code path that assumes a
    // string keeps working.
    assert.equal(buildContent("hello", []), "hello");
  });

  test("puts the text first", () => {
    // Several providers weight the leading part more heavily, and a question
    // arriving after four images reads as an afterthought.
    const content = buildContent("describe this", [
      { kind: "image", mime: "image/png", base64: PNG_BASE64 },
    ]);

    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image_url");
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  });

  test("a PDF becomes a file part, not an image part", () => {
    const [part] = buildContent("", [{ kind: "pdf", mime: "application/pdf", base64: "AAA" }]);
    assert.equal(part.type, "file");
    assert.equal(part.file.mime, "application/pdf");
  });

  test("eliding keeps the shape and drops the payload", () => {
    const content = buildContent("hi", [{ kind: "image", mime: "image/png", base64: PNG_BASE64 }]);
    const elided = withoutPayloads(content);

    assert.equal(elided[0].text, "hi");
    assert.equal(elided[1].elided, true);
    assert.ok(!JSON.stringify(elided).includes(PNG_BASE64));
  });
});
