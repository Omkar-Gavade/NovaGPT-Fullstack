import { ProviderError, FailureKind, CancelledError } from "../../../domain/errors/index.js";

/**
 * The single HTTP path every REST adapter shares.
 *
 * Timeout, cancellation, and error mapping in one place, so eight adapters
 * cannot drift into eight different behaviours — which is precisely what the
 * router's retry and failover logic depends on not happening
 * (docs/backend/03-provider-system.md#error-taxonomy).
 *
 * Retry is deliberately **not** here. The router owns retry: it can see the
 * whole fleet and decide between trying again and going elsewhere, while a
 * layer this low can only ever do the former. Retrying here would also
 * multiply with the router's own retries — three attempts becoming nine.
 */
export class HttpClient {
  /**
   * @param {object} [deps]
   * @param {typeof fetch} [deps.fetch] injectable so tests intercept at this seam
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} [deps.clock]
   */
  constructor({ fetch: fetchImpl = globalThis.fetch, clock } = {}) {
    this.fetch = fetchImpl;
    this.clock = clock;
  }

  /**
   * @param {string} url
   * @param {object} init
   * @param {object} options
   * @param {number} options.timeoutMs
   * @param {AbortSignal} [options.signal]
   * @param {(status: number|undefined, body: string, cause?: Error) => ProviderError} options.mapError
   * @param {boolean} [options.stream] return the Response rather than parsed JSON
   */
  async request(url, init, { timeoutMs = 60_000, signal, mapError, stream = false }) {
    // Checked before the call, not only in the catch. A request whose caller
    // has already gone away must never reach the provider: sending it burns a
    // quota unit for output nobody will read, and `fetch` does not reliably
    // reject synchronously on an already-aborted signal.
    if (signal?.aborted) throw new CancelledError();

    const controller = new AbortController();
    const onAbort = () => controller.abort(new CancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });

      if (!response.ok) {
        // Read the body before mapping: providers put the distinguishing detail
        // there, and `429` alone cannot tell quota from rate limit.
        const body = await response.text().catch(() => "");
        throw mapError(response.status, body);
      }

      return stream ? response : await response.json();
    } catch (error) {
      if (ProviderError.is(error)) throw error;

      // Our deadline is checked before the caller's cancellation, so a timeout
      // is never mistaken for a user pressing stop — they lead to opposite
      // routing decisions.
      if (timedOut) throw mapError(undefined, "", new Error("timeout"));
      if (signal?.aborted || CancelledError.is(error) || error?.name === "AbortError") {
        throw new CancelledError();
      }

      // DNS failure, connection refused, TLS error: the provider is unreachable,
      // which is an outage and worth failing over.
      throw mapError(undefined, error?.message ?? "", error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The shared status → `FailureKind` mapping.
 *
 * Every adapter uses this, and may narrow it where a provider is known to
 * deviate. Centralising it is what makes the taxonomy trustworthy: one place to
 * read, one place to fix.
 */
export function mapHttpError(status, body, cause, { providerId, providerName }) {
  if (!status && /timeout/i.test(cause?.message ?? "")) {
    return new ProviderError(`${providerName} timed out`, FailureKind.TIMEOUT, {
      provider: providerId,
    });
  }

  if (status === 401 || status === 403) {
    // Never includes the body: an auth failure response frequently echoes the
    // key or an account identifier.
    return new ProviderError(`${providerName} rejected the credentials`, FailureKind.AUTH, {
      provider: providerId,
      upstreamStatus: status,
    });
  }

  if (status === 429) {
    // The distinction the router most depends on. Quota means the allowance is
    // gone and waiting will not help; a rate limit clears in about a minute.
    const isQuota = /quota|billing|credit|insufficient|exceeded your current/i.test(body ?? "");
    return new ProviderError(
      isQuota ? `${providerName} quota reached` : `${providerName} rate limit reached`,
      isQuota ? FailureKind.QUOTA : FailureKind.RATE_LIMIT,
      {
        provider: providerId,
        upstreamStatus: status,
        retryAfter: parseRetryAfter(body),
      }
    );
  }

  if (status === 408 || status === 504) {
    return new ProviderError(`${providerName} timed out`, FailureKind.TIMEOUT, {
      provider: providerId,
      upstreamStatus: status,
    });
  }

  if (!status || status >= 500) {
    return new ProviderError(`${providerName} is unavailable`, FailureKind.OUTAGE, {
      provider: providerId,
      upstreamStatus: status,
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  // A 4xx that is our fault — malformed request, unknown model, content filter.
  // Classified as api_error, which the router will NOT fail over on, because
  // the same bad request would fail identically everywhere.
  return new ProviderError(
    `${providerName} rejected the request`,
    FailureKind.API_ERROR,
    { provider: providerId, upstreamStatus: status, cause: safeCause(body) }
  );
}

/**
 * `Retry-After` from a JSON error body.
 *
 * Header parsing happens at the call site where the response is available; this
 * covers providers that put it in the body instead.
 */
function parseRetryAfter(body) {
  const match = /retry[-_ ]?after["'\s:]+(\d+(?:\.\d+)?)/i.exec(body ?? "");
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Keep an upstream body for the logs only, truncated.
 *
 * It never reaches a client: provider bodies can carry account identifiers,
 * endpoint paths, and fragments of the request.
 */
function safeCause(body) {
  if (!body) return undefined;
  const error = new Error(String(body).slice(0, 500));
  error.name = "UpstreamBody";
  return error;
}
