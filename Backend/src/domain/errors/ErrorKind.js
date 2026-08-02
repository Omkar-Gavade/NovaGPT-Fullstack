/**
 * Canonical error kinds. Clients branch on these, never on the message text.
 *
 * The set and its HTTP mapping are the contract defined in
 * docs/backend/09-api-design.md#error-kinds-and-status-codes. Adding a kind is
 * additive; changing an existing kind's status is a breaking API change.
 */
export const ErrorKind = {
  VALIDATION: "validation",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota",
  UNSUPPORTED_CAPABILITY: "unsupported_capability",
  PROVIDER_ERROR: "provider_error",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  TIMEOUT: "timeout",
  INTERNAL: "internal",
};

/** Kind -> HTTP status. The single place this mapping exists. */
const STATUS_BY_KIND = {
  [ErrorKind.VALIDATION]: 400,
  [ErrorKind.UNAUTHENTICATED]: 401,
  [ErrorKind.FORBIDDEN]: 403,
  [ErrorKind.NOT_FOUND]: 404,
  [ErrorKind.CONFLICT]: 409,
  [ErrorKind.PAYLOAD_TOO_LARGE]: 413,
  [ErrorKind.UNSUPPORTED_CAPABILITY]: 422,
  [ErrorKind.RATE_LIMITED]: 429,
  [ErrorKind.QUOTA]: 429,
  [ErrorKind.INTERNAL]: 500,
  [ErrorKind.PROVIDER_ERROR]: 502,
  [ErrorKind.PROVIDER_UNAVAILABLE]: 503,
  [ErrorKind.TIMEOUT]: 504,
};

/**
 * HTTP status for a kind. Unknown kinds map to 500 rather than throwing —
 * an error while handling an error must never mask the original.
 */
export function statusForKind(kind) {
  return STATUS_BY_KIND[kind] ?? 500;
}

/** True when the kind represents a fault on our side rather than the caller's. */
export function isServerFault(kind) {
  return statusForKind(kind) >= 500;
}
