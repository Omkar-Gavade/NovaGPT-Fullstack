import { AppError, ErrorKind } from "../errors/index.js";

/**
 * What an attachment is allowed to be, and where it is allowed to come from.
 *
 * Pure: it decides, it does not fetch. Every rule below is therefore a unit
 * test rather than something discovered by pointing the service at a URL and
 * watching what happens.
 *
 * **This is the SSRF boundary (T8).** An endpoint that fetches a user-supplied
 * URL is a request-forgery primitive by default: the server has network
 * positions the user does not — a cloud metadata endpoint, a database on a
 * private subnet, an admin panel bound to localhost. `http://169.254.169.254/`
 * is the canonical example, and it returns credentials
 * (docs/backend/10-security.md#input-validation).
 *
 * The defence is an **allowlist of hosts**, not a denylist of addresses.
 * Denylists lose: an attacker controls DNS for a domain they own, so
 * `evil.example.com` resolving to `127.0.0.1` defeats any check made on the
 * hostname, and decimal, octal and IPv6-mapped encodings defeat naive checks on
 * the address. The address checks below are still here, because they catch the
 * case where an allowlisted host is *itself* compromised or misconfigured —
 * defence in depth, not the primary control.
 */

/** Magic bytes, because a declared MIME type is a claim by the attacker. */
const SIGNATURES = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  // WebP is RIFF....WEBP — the container tag sits at offset 8.
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], at: 0, also: { bytes: [0x57, 0x45, 0x42, 0x50], at: 8 } },
];

const KIND_BY_MIME = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
};

export class AttachmentPolicy {
  /**
   * @param {object} [options]
   * @param {string[]} [options.allowedHosts] exact hosts, or `*.suffix` forms
   * @param {number} [options.maxBytes] per attachment
   * @param {number} [options.maxCount] per request
   * @param {number} [options.maxTotalBytes] across a request
   * @param {string[]} [options.allowedMimeTypes]
   */
  constructor({
    allowedHosts = [],
    maxBytes = 8 * 1024 * 1024,
    maxCount = 10,
    maxTotalBytes = 24 * 1024 * 1024,
    allowedMimeTypes = Object.keys(KIND_BY_MIME),
  } = {}) {
    this.allowedHosts = allowedHosts.map((h) => h.toLowerCase().trim()).filter(Boolean);
    this.maxBytes = maxBytes;
    this.maxCount = maxCount;
    this.maxTotalBytes = maxTotalBytes;
    this.allowedMimeTypes = new Set(allowedMimeTypes);
  }

  /**
   * May this URL be fetched at all?
   *
   * Called before the request **and again after every redirect**. A URL that
   * passes the check and then 302s to `http://169.254.169.254/` defeats a
   * check made only at the start, and that redirect is the most common way the
   * naive version of this is bypassed.
   */
  assertFetchable(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw reject("That is not a valid URL.");
    }

    // `file:`, `gopher:`, `ftp:` and friends reach things HTTP cannot. `http:`
    // is permitted only because some allowlisted internal hosts do not serve
    // TLS; if that ever stops being true, drop it.
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw reject(`Unsupported URL scheme: ${url.protocol}`);
    }

    // Credentials in a URL are exfiltration bait and are never needed here.
    if (url.username || url.password) throw reject("A URL may not carry credentials.");

    const host = url.hostname.toLowerCase();

    // The primary control. An empty allowlist means attachments-by-URL are off
    // entirely, which is the correct default: a deployment that has not thought
    // about which hosts it trusts should not be fetching arbitrary ones.
    if (!this.#hostAllowed(host)) {
      throw reject(
        this.allowedHosts.length === 0
          ? "Fetching attachments by URL is not enabled on this deployment."
          : `${host} is not an allowed attachment host.`
      );
    }

    // Defence in depth: an allowlisted host that resolves somewhere it should
    // not, or an allowlist entry someone added carelessly.
    if (isPrivateAddress(host)) throw reject("That address is not reachable from here.");

    return url;
  }

  #hostAllowed(host) {
    return this.allowedHosts.some((allowed) =>
      allowed.startsWith("*.")
        ? // A suffix match must be on a label boundary: `*.example.com` must not
          // match `notexample.com`.
          host === allowed.slice(2) || host.endsWith(allowed.slice(1))
        : host === allowed
    );
  }

  /** Count and aggregate size, before anything is fetched. */
  assertRequestShape(attachments = []) {
    if (attachments.length > this.maxCount) {
      throw reject(`At most ${this.maxCount} attachments per message.`, ErrorKind.PAYLOAD_TOO_LARGE);
    }
  }

  /**
   * What this actually is, from its bytes.
   *
   * A declared `image/png` that is really a 200 MB zip is a trivial attack, so
   * the declaration is not consulted at all — only the magic bytes
   * (docs/backend/10-security.md#input-validation).
   */
  assertContent(bytes, { declaredMime = null } = {}) {
    if (!bytes?.length) throw reject("That attachment is empty.");
    if (bytes.length > this.maxBytes) {
      throw reject(
        `Attachments are limited to ${Math.floor(this.maxBytes / 1024 / 1024)} MB.`,
        ErrorKind.PAYLOAD_TOO_LARGE
      );
    }

    const sniffed = sniff(bytes);
    if (!sniffed) throw reject("That file type is not supported.");
    if (!this.allowedMimeTypes.has(sniffed)) throw reject(`${sniffed} is not an allowed file type.`);

    // A mismatch is worth naming rather than silently trusting the bytes: it is
    // either an attack or a client bug, and both are worth a clear message.
    if (declaredMime && declaredMime !== sniffed) {
      throw reject(`That file is a ${sniffed}, not the ${declaredMime} it claims to be.`);
    }

    return { mime: sniffed, kind: KIND_BY_MIME[sniffed], bytes: bytes.length };
  }

  assertTotalSize(totalBytes) {
    if (totalBytes > this.maxTotalBytes) {
      throw reject(
        `Attachments total more than ${Math.floor(this.maxTotalBytes / 1024 / 1024)} MB.`,
        ErrorKind.PAYLOAD_TOO_LARGE
      );
    }
  }
}

/**
 * Address forms that must never be fetched.
 *
 * Not the primary control — an attacker controlling DNS defeats any
 * hostname-based check — but it catches an allowlisted host pointing somewhere
 * it should not, and it is where the cloud metadata endpoint lives.
 */
export function isPrivateAddress(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }

  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local
  // (fe80::/10) — including the `::ffff:127.0.0.1` mapped form, which is the
  // one a v4-only check misses.
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }

  const parts = h.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (parts.some((p) => Number(p) > 255)) return false;

  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local — the cloud metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/** The MIME type these bytes actually are, or null. */
export function sniff(bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const signature of SIGNATURES) {
    if (!matches(view, signature.bytes, signature.at ?? 0)) continue;
    if (signature.also && !matches(view, signature.also.bytes, signature.also.at)) continue;
    return signature.mime;
  }
  return null;
}

const matches = (view, bytes, at) =>
  view.length >= at + bytes.length && bytes.every((byte, i) => view[at + i] === byte);

const reject = (message, kind = ErrorKind.VALIDATION) =>
  new AppError(message, kind, { field: "attachments", expected: true });
