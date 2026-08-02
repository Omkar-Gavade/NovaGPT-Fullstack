import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  ErrorKind,
  statusForKind,
  isServerFault,
  validationError,
  notFound,
  FailureKind,
  ProviderError,
  UnsupportedCapabilityError,
} from "../../src/domain/errors/index.js";

describe("ErrorKind mapping", () => {
  test("maps every kind to the documented status", () => {
    const expected = {
      validation: 400,
      unauthenticated: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      unsupported_capability: 422,
      rate_limited: 429,
      quota: 429,
      internal: 500,
      provider_error: 502,
      provider_unavailable: 503,
      timeout: 504,
    };
    for (const kind of Object.values(ErrorKind)) {
      assert.equal(statusForKind(kind), expected[kind], `kind ${kind}`);
    }
  });

  test("an unknown kind maps to 500 rather than throwing", () => {
    assert.equal(statusForKind("nonsense"), 500);
  });

  test("distinguishes server faults from client faults", () => {
    assert.ok(isServerFault(ErrorKind.INTERNAL));
    assert.ok(isServerFault(ErrorKind.PROVIDER_UNAVAILABLE));
    assert.ok(!isServerFault(ErrorKind.VALIDATION));
    assert.ok(!isServerFault(ErrorKind.QUOTA));
  });
});

describe("AppError", () => {
  test("defaults to an internal error", () => {
    const error = new AppError("boom");
    assert.equal(error.kind, ErrorKind.INTERNAL);
    assert.equal(error.status, 500);
  });

  test("marks client faults expected and server faults not", () => {
    assert.ok(validationError("bad", "name").expected);
    assert.ok(!new AppError("boom", ErrorKind.INTERNAL).expected);
  });

  test("an explicit expected flag overrides the default", () => {
    assert.ok(new AppError("boom", ErrorKind.INTERNAL, { expected: true }).expected);
  });

  test("passes an AppError through unchanged", () => {
    const original = notFound("Thread");
    assert.equal(AppError.from(original), original);
  });

  test("wraps an unknown throwable without leaking its message", () => {
    const wrapped = AppError.from(new Error("mongodb://admin:s3cret@host failed"));
    assert.equal(wrapped.kind, ErrorKind.INTERNAL);
    // The original text may carry a credential, so it survives only in `cause`,
    // which is logged (and redacted there) but never serialised to a client.
    assert.ok(!wrapped.message.includes("s3cret"));
    assert.ok(wrapped.cause.message.includes("s3cret"));
  });

  test("wraps a non-Error throwable", () => {
    const wrapped = AppError.from("just a string");
    assert.equal(wrapped.kind, ErrorKind.INTERNAL);
    assert.equal(wrapped.cause.message, "just a string");
  });

  test("carries a field for validation errors", () => {
    const error = validationError("Must be a string.", "title");
    assert.equal(error.kind, ErrorKind.VALIDATION);
    assert.equal(error.field, "title");
    assert.equal(error.status, 400);
  });
});

describe("ProviderError taxonomy", () => {
  test("retries only kinds where a second attempt can succeed", () => {
    const retryable = [FailureKind.TIMEOUT, FailureKind.RATE_LIMIT, FailureKind.OUTAGE];
    const not = [FailureKind.QUOTA, FailureKind.AUTH, FailureKind.API_ERROR];
    for (const kind of retryable) {
      assert.ok(new ProviderError("x", kind).isRetryable, `${kind} should retry`);
    }
    for (const kind of not) {
      assert.ok(!new ProviderError("x", kind).isRetryable, `${kind} should not retry`);
    }
  });

  test("never fails over on api_error", () => {
    // The request itself was rejected, so failing over multiplies one error
    // into N (docs/backend/04-router.md#fallback).
    assert.ok(!new ProviderError("bad request", FailureKind.API_ERROR).isFailoverWorthy);
  });

  test("fails over on every operational kind, including auth", () => {
    for (const kind of [
      FailureKind.QUOTA,
      FailureKind.RATE_LIMIT,
      FailureKind.TIMEOUT,
      FailureKind.OUTAGE,
      FailureKind.AUTH,
    ]) {
      assert.ok(new ProviderError("x", kind).isFailoverWorthy, `${kind}`);
    }
  });

  test("opens the breaker immediately only where a retry cannot help", () => {
    assert.ok(new ProviderError("x", FailureKind.QUOTA).opensBreakerImmediately);
    assert.ok(new ProviderError("x", FailureKind.AUTH).opensBreakerImmediately);
    assert.ok(!new ProviderError("x", FailureKind.TIMEOUT).opensBreakerImmediately);
  });

  test("cooldown length matches the cause's expected recovery time", () => {
    assert.equal(new ProviderError("x", FailureKind.QUOTA).cooldownMs, 15 * 60_000);
    assert.equal(new ProviderError("x", FailureKind.RATE_LIMIT).cooldownMs, 60_000);
    assert.equal(new ProviderError("x", FailureKind.TIMEOUT).cooldownMs, 30_000);
  });

  test("treats auth as unexpected, because a human must act", () => {
    assert.ok(!new ProviderError("x", FailureKind.AUTH).expected);
    assert.ok(new ProviderError("x", FailureKind.QUOTA).expected);
  });

  test("maps failure kinds onto client-facing error kinds", () => {
    assert.equal(new ProviderError("x", FailureKind.QUOTA).kind, ErrorKind.QUOTA);
    assert.equal(new ProviderError("x", FailureKind.RATE_LIMIT).kind, ErrorKind.RATE_LIMITED);
    assert.equal(new ProviderError("x", FailureKind.OUTAGE).kind, ErrorKind.PROVIDER_UNAVAILABLE);
    assert.equal(new ProviderError("x", FailureKind.TIMEOUT).kind, ErrorKind.TIMEOUT);
  });

  test("surfaces retryAfter as client-safe details", () => {
    const error = new ProviderError("slow down", FailureKind.RATE_LIMIT, { retryAfter: 30 });
    assert.deepEqual(error.details, { retryAfterSeconds: 30 });
  });

  test("is an AppError, so the error handler needs no special case", () => {
    assert.ok(AppError.is(new ProviderError("x", FailureKind.QUOTA)));
  });
});

describe("UnsupportedCapabilityError", () => {
  test("is a 422 carrying the provider and capability", () => {
    const error = new UnsupportedCapabilityError("groq", "vision");
    assert.equal(error.kind, ErrorKind.UNSUPPORTED_CAPABILITY);
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, { provider: "groq", capability: "vision" });
  });
});
