import { AppError, ErrorKind } from "../../domain/errors/index.js";

/**
 * Turns what a client sent into bytes the router can hand a provider.
 *
 * Two sources, and they have different risks:
 *
 *   **Inline base64** is bounded by the body limit the parser already enforces,
 *   so the only checks needed are size and content sniffing.
 *
 *   **A URL** is an SSRF primitive (T8), and this is where the policy earns its
 *   keep: allowlist, redirect re-validation, a streaming size cap, and MIME
 *   sniffed from the first bytes rather than read off a header the server
 *   controls.
 *
 * The policy decides; this fetches. Keeping the decision pure is what makes
 * every rule a unit test rather than something observed by pointing the service
 * at a URL and watching (docs/backend/10-security.md#input-validation).
 */
export class AttachmentIngestor {
  /**
   * @param {object} deps
   * @param {import("../../domain/attachment/AttachmentPolicy.js").AttachmentPolicy} deps.policy
   * @param {typeof fetch} [deps.fetch]
   * @param {object} [deps.logger]
   * @param {object} [deps.metrics]
   * @param {number} [deps.timeoutMs]
   */
  constructor({ policy, fetch: fetchImpl = globalThis.fetch, logger, metrics, timeoutMs = 10_000 }) {
    this.policy = policy;
    this.fetch = fetchImpl;
    this.logger = logger?.child?.({ component: "attachments" }) ?? logger;
    this.metrics = metrics;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {object[]} attachments as the client sent them
   * @returns {Promise<object[]>} `{ kind, mime, base64, bytes }`
   */
  async ingest(attachments = [], { signal } = {}) {
    if (!attachments.length) return [];

    try {
      return await this.#ingestAll(attachments, { signal });
    } catch (error) {
      // Counted by *reason*, not by message: the reason is a bounded set and
      // the message is copy. A rise in `host_not_allowed` is someone probing
      // the SSRF surface, and it should be visible as a shape rather than
      // needing a log query (docs/backend/11-observability.md).
      this.metrics?.increment("nova_attachments_rejected_total", { reason: reasonFor(error) });
      throw error;
    }
  }

  async #ingestAll(attachments, { signal }) {
    this.policy.assertRequestShape(attachments);

    const resolved = [];
    let total = 0;

    for (const attachment of attachments) {
      const bytes = attachment.data
        ? decodeBase64(attachment.data)
        : await this.#download(attachment.url, { signal });

      const { mime, kind } = this.policy.assertContent(bytes, {
        declaredMime: attachment.mimeType ?? null,
      });

      total += bytes.length;
      // Checked as they accumulate rather than at the end: ten files just under
      // the individual cap is still a resource-exhaustion vector, and there is
      // no reason to finish downloading the tenth once the total is exceeded.
      this.policy.assertTotalSize(total);

      resolved.push({ kind, mime, base64: bytes.toString("base64"), bytes: bytes.length });
      this.metrics?.increment("nova_attachments_total", { kind, source: attachment.data ? "inline" : "url" });
    }

    return resolved;
  }

  async #download(url, { signal }) {
    // Validated before the request, and again after every redirect below.
    this.policy.assertFetchable(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      // `redirect: "manual"` is the load-bearing part. A URL that passes the
      // allowlist and then 302s to `http://169.254.169.254/` defeats a check
      // made only at the start — and following redirects automatically is the
      // single most common way this defence is bypassed.
      let current = url;
      let response;

      for (let hop = 0; hop <= 3; hop += 1) {
        response = await this.fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/*,application/pdf" },
        });

        if (!isRedirect(response.status)) break;

        const location = response.headers.get("location");
        if (!location) throw reject("That URL redirected without a destination.");

        current = new URL(location, current).toString();
        // The whole point: the destination gets the same scrutiny as the origin.
        this.policy.assertFetchable(current);

        if (hop === 3) throw reject("That URL redirected too many times.");
      }

      if (!response.ok) {
        throw reject(`Could not fetch that attachment (HTTP ${response.status}).`);
      }

      return await this.#readCapped(response);
    } catch (error) {
      if (AppError.is(error)) throw error;
      if (error?.name === "AbortError") throw reject("Fetching that attachment timed out.");
      // The upstream message is not forwarded: it may name internal hosts.
      this.logger?.warn("attachments.fetch_failed", { error });
      throw reject("Could not fetch that attachment.");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read with the cap enforced **as it streams**.
   *
   * A `Content-Length` check is not enough: the header is supplied by the
   * server being fetched, and a hostile one can understate it or omit it
   * entirely. Buffering the whole body first and checking afterwards is the
   * resource exhaustion this is meant to prevent.
   */
  async #readCapped(response) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.policy.maxBytes) {
      throw reject("That attachment is too large.", ErrorKind.PAYLOAD_TOO_LARGE);
    }

    if (!response.body) return Buffer.from(await response.arrayBuffer());

    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > this.policy.maxBytes) {
        throw reject("That attachment is too large.", ErrorKind.PAYLOAD_TOO_LARGE);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

const isRedirect = (status) => status >= 300 && status < 400;

/** A bounded label. Anything unrecognised is `other` rather than a new series. */
function reasonFor(error) {
  const message = String(error?.message ?? "");
  if (/not an allowed attachment host|not enabled on this deployment/i.test(message)) return "host_not_allowed";
  if (/not reachable from here/i.test(message)) return "private_address";
  if (/Unsupported URL scheme|carry credentials|not a valid URL/i.test(message)) return "bad_url";
  if (/too large|total more than|At most/i.test(message)) return "too_large";
  if (/not supported|not an allowed file type|not the /i.test(message)) return "bad_content";
  if (/redirected/i.test(message)) return "redirect";
  if (/timed out|Could not fetch/i.test(message)) return "fetch_failed";
  return "other";
}

function decodeBase64(value) {
  const cleaned = String(value).replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(cleaned, "base64");
  if (!bytes.length) throw reject("That attachment could not be decoded.");
  return bytes;
}

const reject = (message, kind = ErrorKind.VALIDATION) =>
  new AppError(message, kind, { field: "attachments", expected: true });
