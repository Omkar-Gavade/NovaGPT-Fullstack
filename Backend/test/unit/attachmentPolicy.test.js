import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AttachmentPolicy, isPrivateAddress, sniff } from "../../src/domain/attachment/AttachmentPolicy.js";

/**
 * The SSRF boundary (T8).
 *
 * An endpoint that fetches a user-supplied URL is a request-forgery primitive
 * by default: the server has network positions the user does not. Most of this
 * file is attacks, because the interesting behaviour is refusal.
 */

const policy = (extra = {}) =>
  new AttachmentPolicy({ allowedHosts: ["cdn.example.com", "*.assets.example.com"], ...extra });

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pdf = () => Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe("attachment policy — where a URL may point", () => {
  test("allows an allowlisted host", () => {
    assert.equal(policy().assertFetchable("https://cdn.example.com/a.png").hostname, "cdn.example.com");
  });

  test("allows a wildcard subdomain, on a label boundary", () => {
    assert.ok(policy().assertFetchable("https://img.assets.example.com/a.png"));
    // The bug a naive `endsWith` produces: `notassets.example.com` must not
    // match `*.assets.example.com`.
    assert.throws(() => policy().assertFetchable("https://evilassets.example.com/a.png"));
  });

  test("refuses a host that is not on the list", () => {
    assert.throws(() => policy().assertFetchable("https://evil.example.net/a.png"), /not an allowed/);
  });

  test("refuses everything when no allowlist is configured", () => {
    // The correct default. A deployment that has not decided which hosts it
    // trusts should not be fetching arbitrary ones.
    assert.throws(
      () => new AttachmentPolicy().assertFetchable("https://cdn.example.com/a.png"),
      /not enabled/
    );
  });

  test("refuses schemes that reach things HTTP cannot", () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://cdn.example.com/",
      "ftp://cdn.example.com/a.png",
      "data:image/png;base64,AAAA",
    ]) {
      assert.throws(() => policy().assertFetchable(url), `${url} should be refused`);
    }
  });

  test("refuses credentials embedded in a URL", () => {
    // Exfiltration bait, and never needed here.
    assert.throws(
      () => policy().assertFetchable("https://user:pass@cdn.example.com/a.png"),
      /credentials/
    );
  });

  test("refuses an allowlisted host that resolves somewhere private", () => {
    // Defence in depth: the allowlist is the control, but an entry someone
    // added carelessly must not open the whole private network.
    const permissive = new AttachmentPolicy({ allowedHosts: ["127.0.0.1", "169.254.169.254"] });
    assert.throws(() => permissive.assertFetchable("http://127.0.0.1/admin"), /not reachable/);
    assert.throws(() => permissive.assertFetchable("http://169.254.169.254/"), /not reachable/);
  });
});

describe("private address detection", () => {
  test("blocks the cloud metadata endpoint", () => {
    // The canonical SSRF target, and it returns credentials.
    assert.equal(isPrivateAddress("169.254.169.254"), true);
  });

  test("blocks every private and reserved IPv4 range", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1",
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  test("blocks IPv6 loopback, unique-local and link-local", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "[::1]"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  test("blocks the IPv4-mapped IPv6 form", () => {
    // The one a v4-only check misses.
    assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
  });

  test("blocks localhost by name, including suffixed forms", () => {
    for (const host of ["localhost", "app.localhost", "db.internal", "printer.local"]) {
      assert.equal(isPrivateAddress(host), true, host);
    }
  });

  test("permits ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1"]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });
});

describe("attachment policy — what a file may be", () => {
  test("identifies a file from its bytes", () => {
    assert.equal(sniff(png()), "image/png");
    assert.equal(sniff(pdf()), "application/pdf");
    assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniff(Buffer.from("RIFF____WEBPVP8 ")), "image/webp");
  });

  test("a declared type is never trusted over the bytes", () => {
    // A declared image/png that is really a 200 MB zip is a trivial attack.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(sniff(zip), null);
    assert.throws(() => policy().assertContent(zip, { declaredMime: "image/png" }), /not supported/);
  });

  test("a mismatch between claim and content is named, not silently accepted", () => {
    assert.throws(
      () => policy().assertContent(png(), { declaredMime: "application/pdf" }),
      /is a image\/png, not the application\/pdf/
    );
  });

  test("accepts a file whose claim matches its bytes", () => {
    const result = policy().assertContent(png(), { declaredMime: "image/png" });
    assert.deepEqual({ mime: result.mime, kind: result.kind }, { mime: "image/png", kind: "image" });
  });

  test("classifies a PDF as its own kind, not as an image", () => {
    // Routing derives `pdf` from this, and a PDF sent to a vision-only model
    // fails at the provider rather than at the router.
    assert.equal(policy().assertContent(pdf()).kind, "pdf");
  });

  test("refuses an empty file", () => {
    assert.throws(() => policy().assertContent(Buffer.alloc(0)), /empty/);
  });

  test("caps a single attachment", () => {
    const big = Buffer.concat([png(), Buffer.alloc(200)]);
    assert.throws(() => policy({ maxBytes: 100 }).assertContent(big), /limited to/);
  });

  test("caps the number per request", () => {
    assert.throws(
      () => policy({ maxCount: 2 }).assertRequestShape([{}, {}, {}]),
      /At most 2 attachments/
    );
  });

  test("caps the total across a request", () => {
    // Ten files just under the individual cap is still a resource-exhaustion
    // vector without this.
    assert.throws(() => policy({ maxTotalBytes: 1000 }).assertTotalSize(1001), /total more than/);
  });

  test("a refusal is a 4xx, not a server error", () => {
    // These are the caller's mistakes. Reporting them as 500s would pollute the
    // server-error rate every alert is built on.
    try {
      policy().assertFetchable("https://evil.example.net/a.png");
      assert.fail("should have thrown");
    } catch (error) {
      assert.equal(error.status, 400);
      assert.equal(error.expected, true);
    }
  });
});
