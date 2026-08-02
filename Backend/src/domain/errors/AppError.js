import { ErrorKind, statusForKind } from "./ErrorKind.js";

/**
 * The application's error type. Every error that reaches the HTTP boundary is
 * either an AppError or is wrapped into one as `internal`.
 *
 * `message` MUST be safe to show an end user: no stack traces, no internal
 * hostnames, no upstream bodies, nothing derived from a credential
 * (docs/backend/10-security.md#structural-defences-against-leakage-t1). Anything
 * unsafe belongs in `cause`, which is logged but never serialised to a client.
 */
export class AppError extends Error {
  /**
   * @param {string} message   user-safe message
   * @param {string} kind      one of ErrorKind
   * @param {object} [options]
   * @param {string} [options.field]    which input was wrong, for validation errors
   * @param {object} [options.details]  kind-specific structured context, client-safe
   * @param {Error}  [options.cause]    the underlying error — logged, never serialised
   * @param {boolean} [options.expected] true when this is normal operation, not a defect
   */
  constructor(message, kind = ErrorKind.INTERNAL, { field, details, cause, expected } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.kind = kind;
    this.field = field ?? null;
    this.details = details ?? null;
    // Quota and rate limits are expected on free tiers; logging them at error
    // level trains operators to ignore errors (docs/backend/11-observability.md).
    this.expected = expected ?? !isServerSide(kind);
  }

  get status() {
    return statusForKind(this.kind);
  }

  /** True when the value is an AppError, including across module realms. */
  static is(value) {
    return value instanceof AppError || value?.name === "AppError";
  }

  /**
   * Coerce anything thrown into an AppError.
   * Unknown values become `internal` with a generic message: the original text
   * may contain a connection string, a file path, or a credential, so it is
   * preserved only in `cause` for the logger.
   */
  static from(value) {
    if (AppError.is(value)) return value;
    const cause = value instanceof Error ? value : new Error(String(value));
    return new AppError("An unexpected error occurred.", ErrorKind.INTERNAL, { cause });
  }
}

function isServerSide(kind) {
  return statusForKind(kind) >= 500;
}

/* -------------------------------------------------------------------------- *
 * Factories. Present so call sites read as intent rather than as construction,
 * and so the kind for a given situation is decided in one place.
 * -------------------------------------------------------------------------- */

export const validationError = (message, field, details) =>
  new AppError(message, ErrorKind.VALIDATION, { field, details });

export const notFound = (resource) =>
  new AppError(`${resource} not found.`, ErrorKind.NOT_FOUND);

export const unauthenticated = (message = "Authentication required.") =>
  new AppError(message, ErrorKind.UNAUTHENTICATED);

export const forbidden = (message = "You do not have access to this resource.") =>
  new AppError(message, ErrorKind.FORBIDDEN);

export const conflict = (message, details) =>
  new AppError(message, ErrorKind.CONFLICT, { details });

export const payloadTooLarge = (message = "Request body is too large.") =>
  new AppError(message, ErrorKind.PAYLOAD_TOO_LARGE);

export const timeout = (message = "The request took too long.") =>
  new AppError(message, ErrorKind.TIMEOUT);

export const internal = (cause, message = "An unexpected error occurred.") =>
  new AppError(message, ErrorKind.INTERNAL, { cause });
