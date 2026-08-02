import { AppError } from "./AppError.js";
import { ErrorKind } from "./ErrorKind.js";

/**
 * The six-kind provider failure taxonomy
 * (docs/backend/03-provider-system.md#error-taxonomy).
 *
 * Each kind exists because it maps to a *distinct decision*: retry the same
 * provider? route elsewhere? open the breaker, and for how long? A seventh kind
 * that answers all three the same way as an existing one earns nothing.
 *
 * Defined in Phase 1 as pure domain vocabulary. No provider adapter exists yet;
 * this is the contract they will be held to (roadmap deliverable 1.3).
 */
export const FailureKind = {
  QUOTA: "quota",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  OUTAGE: "outage",
  AUTH: "auth",
  API_ERROR: "api_error",
};

/**
 * Kinds worth retrying against the *same* provider.
 * `quota` and `auth` are facts about provider state — a retry is guaranteed
 * waste. `api_error` means the request was bad and will fail identically.
 */
const RETRYABLE = new Set([FailureKind.TIMEOUT, FailureKind.RATE_LIMIT, FailureKind.OUTAGE]);

/**
 * Kinds worth trying a *different* provider.
 * `api_error` is excluded deliberately: the request was rejected, so failing
 * over multiplies one error into N (docs/backend/04-router.md#fallback).
 */
const FAILOVER_WORTHY = new Set([
  FailureKind.QUOTA,
  FailureKind.RATE_LIMIT,
  FailureKind.TIMEOUT,
  FailureKind.OUTAGE,
  FailureKind.AUTH,
]);

/** Breaker cooldown per kind, matched to that cause's expected recovery time. */
export const COOLDOWN_MS = {
  [FailureKind.QUOTA]: 15 * 60_000,
  [FailureKind.RATE_LIMIT]: 60_000,
  [FailureKind.OUTAGE]: 2 * 60_000,
  [FailureKind.TIMEOUT]: 30_000,
  [FailureKind.AUTH]: 5 * 60_000,
  [FailureKind.API_ERROR]: 30_000,
};

/** Kinds that open the breaker on the first failure, because a retry cannot help. */
const OPENS_IMMEDIATELY = new Set([FailureKind.QUOTA, FailureKind.AUTH]);

/** Provider failure kind -> the API error kind a client sees. */
const CLIENT_KIND = {
  [FailureKind.QUOTA]: ErrorKind.QUOTA,
  [FailureKind.RATE_LIMIT]: ErrorKind.RATE_LIMITED,
  [FailureKind.TIMEOUT]: ErrorKind.TIMEOUT,
  [FailureKind.OUTAGE]: ErrorKind.PROVIDER_UNAVAILABLE,
  [FailureKind.AUTH]: ErrorKind.PROVIDER_ERROR,
  [FailureKind.API_ERROR]: ErrorKind.PROVIDER_ERROR,
};

export class ProviderError extends AppError {
  /**
   * @param {string} message
   * @param {string} kind      one of FailureKind
   * @param {object} [options]
   * @param {string} [options.provider]
   * @param {number} [options.upstreamStatus] the provider's HTTP status
   * @param {number} [options.retryAfter]  seconds, when the provider said so
   * @param {Error}  [options.cause]
   */
  constructor(
    message,
    kind = FailureKind.API_ERROR,
    { provider, upstreamStatus, retryAfter, cause } = {}
  ) {
    super(message, CLIENT_KIND[kind] ?? ErrorKind.PROVIDER_ERROR, {
      cause,
      details: retryAfter ? { retryAfterSeconds: retryAfter } : null,
      // Operational provider failures are expected on free tiers. `auth` is not:
      // it means a credential is broken and a human must act.
      expected: kind !== FailureKind.AUTH,
    });
    this.name = "ProviderError";
    this.failureKind = kind;
    this.provider = provider ?? null;
    // Named `upstreamStatus`, not `status`: AppError.status is the HTTP status
    // *we* return, and the two are routinely different — a provider's 429 for
    // quota is our 429, but its 500 is our 503. Collapsing them into one field
    // would also shadow the AppError getter.
    this.upstreamStatus = upstreamStatus ?? null;
    this.retryAfter = retryAfter ?? null;
  }

  /** True when retrying this same provider is likely to help. */
  get isRetryable() {
    return RETRYABLE.has(this.failureKind);
  }

  /** True when trying a different provider is likely to help. */
  get isFailoverWorthy() {
    return FAILOVER_WORTHY.has(this.failureKind);
  }

  /** True when the breaker should open on this single failure. */
  get opensBreakerImmediately() {
    return OPENS_IMMEDIATELY.has(this.failureKind);
  }

  get cooldownMs() {
    return COOLDOWN_MS[this.failureKind] ?? 30_000;
  }

  static is(value) {
    return value instanceof ProviderError || value?.name === "ProviderError";
  }
}

/**
 * Thrown when a provider genuinely cannot perform a capability.
 *
 * MUST be a throw, never an empty result: an empty return is indistinguishable
 * from a model that had nothing to say, so the router would treat it as success
 * and the failover machinery would never engage
 * (docs/backend/03-provider-system.md#unsupported-capabilities).
 */
export class UnsupportedCapabilityError extends AppError {
  constructor(provider, capability) {
    super(
      `${provider} does not support ${capability}.`,
      ErrorKind.UNSUPPORTED_CAPABILITY,
      { details: { provider, capability } }
    );
    this.name = "UnsupportedCapabilityError";
    this.provider = provider;
    this.capability = capability;
  }
}
