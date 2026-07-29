import { ulid } from "ulid";
import { runWithContext } from "../../../infrastructure/telemetry/traceContext.js";

/**
 * Establish request correlation.
 *
 * Three identifiers, because they answer three different questions:
 *
 *   traceId       the whole operation, across every service and retry. This is
 *                 the id on every log line, every usage record, and every error
 *                 response (docs/backend/11-observability.md#correlation).
 *   requestId     this one HTTP hop. Distinct from traceId so a retried request
 *                 is distinguishable from its original.
 *   correlationId a caller-supplied business key, propagated untouched so a
 *                 client can tie our logs to its own.
 *
 * ULIDs rather than UUIDs: they sort lexicographically by time, so a list of
 * ids is chronologically ordered without a separate timestamp and they index
 * better in time-ordered stores.
 */

/**
 * Inbound header values are untrusted input. They are echoed into response
 * headers and written to logs, so an unvalidated value is both a header
 * injection vector and a log injection vector — a newline in a header would let
 * a caller forge log lines. The allowlist is deliberately narrower than any
 * plausible legitimate id.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sanitize(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : null;
}

/**
 * W3C `traceparent`: `00-<32 hex trace-id>-<16 hex span-id>-<flags>`.
 * Honoured so NovaGPT joins an existing distributed trace instead of starting
 * an unrelated one when it sits behind a gateway that already traces.
 */
function traceIdFromTraceparent(header) {
  if (typeof header !== "string") return null;
  const parts = header.trim().split("-");
  if (parts.length < 4) return null;
  const [version, traceId] = parts;
  if (!/^[0-9a-f]{2}$/.test(version)) return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (traceId === "0".repeat(32)) return null; // the spec's invalid value
  return traceId;
}

export function requestContext() {
  return function requestContextMiddleware(req, res, next) {
    const requestId = sanitize(req.get("x-request-id")) ?? ulid();
    const correlationId = sanitize(req.get("x-correlation-id"));
    const traceId =
      traceIdFromTraceparent(req.get("traceparent")) ?? correlationId ?? requestId;

    const context = {
      traceId,
      requestId,
      correlationId: correlationId ?? traceId,
    };

    // Echoed so a client can correlate its own logs with ours, and so an
    // operator reading a browser network tab can jump straight to a log query.
    res.set("X-Request-Id", requestId);
    res.set("X-Correlation-Id", context.correlationId);
    res.set("X-Trace-Id", traceId);

    // Also on the request, for code that has `req` but not the async context —
    // error handlers in particular, which can run after the store is gone.
    req.context = context;

    // Everything downstream, through every await, sees this context without it
    // appearing in a single function signature.
    runWithContext(context, () => next());
  };
}
