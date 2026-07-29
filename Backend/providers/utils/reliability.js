import { ProviderError, FailureKind } from "../interfaces/Provider.js";

/** Promise-based delay that rejects if an abort signal fires. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function abortError() {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** Kinds worth retrying against the *same* provider before failing over. */
const RETRYABLE = new Set([FailureKind.TIMEOUT, FailureKind.RATE_LIMIT, FailureKind.OUTAGE]);

/**
 * Run `fn` with exponential backoff + full jitter. Retries only transient
 * `ProviderError`s and honours a server `retryAfter` when present. Aborts
 * immediately if the caller's signal fires.
 */
export async function withRetry(fn, { retries = 2, baseMs = 300, maxMs = 4000, signal } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof ProviderError && RETRYABLE.has(err.kind);
      if (!retryable || attempt >= retries || signal?.aborted) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const wait = err.retryAfter ? err.retryAfter * 1000 : Math.random() * backoff;
      await sleep(wait, signal);
      attempt += 1;
    }
  }
}

/**
 * `fetch` with a timeout, external-signal cancellation, retry, and error
 * mapping — the one HTTP path every REST adapter shares.
 *
 * @param {object} o
 * @param {number} o.timeoutMs
 * @param {AbortSignal} [o.signal]   caller cancellation (client disconnect)
 * @param {(status:number, body:string, cause?:Error)=>ProviderError} o.mapError
 * @param {boolean} [o.retry=true]   retry transient failures before giving up
 * @returns {Response}
 */
export async function resilientFetch(url, init, { timeoutMs = 60_000, signal, mapError, retry = true } = {}) {
  const run = async () => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw mapError(res.status, body);
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err?.name === "AbortError") {
        // distinguish caller cancellation from our timeout
        if (signal?.aborted) throw err;
        throw mapError(undefined, "", err);
      }
      throw mapError(undefined, err?.message ?? "", err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  return retry ? withRetry(run, { signal }) : run();
}

/**
 * Per-provider circuit breaker.
 *
 *   closed     → normal, requests flow
 *   open       → recent failures; reject fast until the cooldown elapses
 *   half-open  → cooldown elapsed; allow one probe. Success closes it, another
 *                failure re-opens it.
 *
 * Quota and auth failures open the breaker immediately (a retry won't help);
 * transient failures open it only once they cross `failureThreshold` in a row.
 */
export class CircuitBreaker {
  static COOLDOWN = {
    [FailureKind.QUOTA]: 15 * 60_000,
    [FailureKind.RATE_LIMIT]: 60_000,
    [FailureKind.OUTAGE]: 2 * 60_000,
    [FailureKind.TIMEOUT]: 30_000,
    [FailureKind.AUTH]: 5 * 60_000,
    [FailureKind.API_ERROR]: 30_000,
  };

  constructor({ failureThreshold = 3 } = {}) {
    this.failureThreshold = failureThreshold;
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastKind = null;
  }

  allowsRequest() {
    if (this.state === "open" && Date.now() >= this.openUntil) this.state = "half-open";
    return this.state !== "open";
  }

  onSuccess() {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastKind = null;
  }

  onFailure(kind = FailureKind.API_ERROR) {
    this.consecutiveFailures += 1;
    this.lastKind = kind;
    const openNow =
      kind === FailureKind.QUOTA ||
      kind === FailureKind.AUTH ||
      this.state === "half-open" ||
      this.consecutiveFailures >= this.failureThreshold;
    if (openNow) {
      this.state = "open";
      this.openUntil = Date.now() + (CircuitBreaker.COOLDOWN[kind] ?? 30_000);
    }
  }

  /** 0..1 health score for the router's ranking. */
  get health() {
    if (this.state === "closed") return 1;
    if (this.state === "half-open") return 0.5;
    return 0;
  }

  snapshot() {
    const cooling = this.state === "open" && Date.now() < this.openUntil;
    return {
      state: cooling ? "open" : this.state === "open" ? "half-open" : this.state,
      health: this.health,
      lastKind: this.lastKind,
      cooldownRemainingMs: cooling ? this.openUntil - Date.now() : 0,
    };
  }
}
