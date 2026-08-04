import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AttachmentIngestor } from "../../src/application/attachment/AttachmentIngestor.js";
import { AttachmentPolicy } from "../../src/domain/attachment/AttachmentPolicy.js";
import { recordingLogger, recordingMetrics } from "../helpers/testDoubles.js";

/**
 * Fetching an attachment, with the policy enforced on the wire.
 *
 * The redirect case is the one to read first: it is the most common way an
 * allowlist is bypassed in practice.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const respond = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body: Readable.from([body]),
  arrayBuffer: async () => body,
});

const build = ({ fetch, ...policyOptions } = {}) =>
  new AttachmentIngestor({
    policy: new AttachmentPolicy({ allowedHosts: ["cdn.example.com"], ...policyOptions }),
    fetch,
    logger: recordingLogger("silent"),
    metrics: recordingMetrics(),
  });

describe("attachment ingestion — inline", () => {
  test("decodes base64 and sniffs the content", async () => {
    const [result] = await build().ingest([{ type: "image", data: PNG.toString("base64") }]);

    assert.equal(result.mime, "image/png");
    assert.equal(result.kind, "image");
    assert.equal(Buffer.from(result.base64, "base64").equals(PNG), true);
  });

  test("accepts a data: URL prefix, since clients send them", async () => {
    const [result] = await build().ingest([
      { type: "image", data: `data:image/png;base64,${PNG.toString("base64")}` },
    ]);
    assert.equal(result.mime, "image/png");
  });

  test("refuses content whose bytes are not what was claimed", async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64");
    await assert.rejects(() => build().ingest([{ type: "image", data: zip }]), /not supported/);
  });
});

describe("attachment ingestion — by URL", () => {
  test("fetches from an allowlisted host", async () => {
    const ingestor = build({ fetch: async () => respond(PNG) });
    const [result] = await ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]);
    assert.equal(result.mime, "image/png");
  });

  test("never fetches a host that is not allowlisted", async () => {
    let called = false;
    const ingestor = build({
      fetch: async () => {
        called = true;
        return respond(PNG);
      },
    });

    await assert.rejects(() => ingestor.ingest([{ type: "image", url: "https://evil.example.net/a.png" }]));
    assert.equal(called, false, "the request must be refused before it is made");
  });

  test("re-validates the destination of a redirect", async () => {
    // **The bypass this defends against.** A URL that passes the allowlist and
    // then 302s to the cloud metadata endpoint defeats a check made only at the
    // start — and following redirects automatically is how that happens.
    const hops = [];
    const ingestor = build({
      fetch: async (url) => {
        hops.push(url);
        if (hops.length === 1) {
          return respond(Buffer.alloc(0), {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return respond(PNG);
      },
    });

    await assert.rejects(
      () => ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]),
      /not an allowed attachment host|not reachable/
    );
    assert.equal(hops.length, 1, "the redirect destination must never be fetched");
  });

  test("follows an allowed redirect", async () => {
    let hop = 0;
    const ingestor = build({
      fetch: async () => {
        hop += 1;
        return hop === 1
          ? respond(Buffer.alloc(0), {
              status: 301,
              headers: { location: "https://cdn.example.com/moved.png" },
            })
          : respond(PNG);
      },
    });

    const [result] = await ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]);
    assert.equal(result.mime, "image/png");
  });

  test("refuses a redirect loop rather than following it forever", async () => {
    const ingestor = build({
      fetch: async () =>
        respond(Buffer.alloc(0), {
          status: 302,
          headers: { location: "https://cdn.example.com/again.png" },
        }),
    });

    await assert.rejects(
      () => ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]),
      /too many times/
    );
  });

  test("enforces the size cap while streaming, not after", async () => {
    // A Content-Length check alone is not enough: the header comes from the
    // server being fetched, and a hostile one omits or understates it.
    const huge = Buffer.concat([PNG, Buffer.alloc(5000)]);
    const ingestor = build({
      maxBytes: 1000,
      fetch: async () => respond(huge), // no content-length header at all
    });

    await assert.rejects(
      () => ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]),
      /too large/
    );
  });

  test("rejects an overstated Content-Length before reading a byte", async () => {
    let read = false;
    const ingestor = build({
      maxBytes: 1000,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === "content-length" ? "999999" : null) },
        get body() {
          read = true;
          return Readable.from([PNG]);
        },
      }),
    });

    await assert.rejects(() => ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]));
    assert.equal(read, false, "no reason to read a body already known to be too large");
  });

  test("does not forward the upstream failure message", async () => {
    // An upstream error may name internal hosts.
    const ingestor = build({ fetch: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:443"); } });

    await assert.rejects(
      () => ingestor.ingest([{ type: "image", url: "https://cdn.example.com/a.png" }]),
      (error) => {
        assert.ok(!error.message.includes("10.0.0.5"), error.message);
        return true;
      }
    );
  });

  test("caps the total across a request, and stops early", async () => {
    let fetches = 0;
    const ingestor = build({
      maxBytes: 10_000,
      maxTotalBytes: 20,
      fetch: async () => {
        fetches += 1;
        return respond(Buffer.concat([PNG, Buffer.alloc(20)]));
      },
    });

    await assert.rejects(
      () =>
        ingestor.ingest([
          { type: "image", url: "https://cdn.example.com/a.png" },
          { type: "image", url: "https://cdn.example.com/b.png" },
          { type: "image", url: "https://cdn.example.com/c.png" },
        ]),
      /total more than/
    );
    // No reason to finish downloading the rest once the budget is blown.
    assert.equal(fetches, 1);
  });
});
