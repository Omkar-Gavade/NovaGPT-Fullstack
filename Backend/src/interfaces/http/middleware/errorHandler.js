import { AppError, ErrorKind, isServerFault } from "../../../domain/errors/index.js";
import { errorEnvelope } from "../serializers/errorEnvelope.js";
import { routeLabel } from "../routeLabel.js";

/**
 * The single exit point for every error.
 *
 * Responsibilities, in order: normalise whatever was thrown into an AppError,
 * log it at a level that matches its severity, record it, and serialise a safe
 * envelope. Nothing else in the codebase writes an error response.
 */
export function errorHandler({ logger, metrics, exposeInternals = false }) {
  // Express identifies an error handler by arity — all four parameters are
  // required even though `next` is only used for one branch.
  // eslint-disable-next-line no-unused-vars
  return function errorHandlerMiddleware(err, req, res, next) {
    const error = normalise(err);
    const traceId = req.context?.traceId ?? null;
    const route = routeLabel(req);

    const fields = { route, method: req.method, kind: error.kind, error };

    // `expected` separates "this is how the system behaves under load" from
    // "a human needs to look at this". Without it, quota and rate-limit errors
    // drown the log at error level and real defects stop being noticed.
    if (isServerFault(error.kind) && !error.expected) logger.error("request.error", fields);
    else logger.warn("request.error", fields);

    metrics.increment("nova_request_errors_total", { route, kind: error.kind });

    // Headers already sent means a response is in flight — most likely a
    // stream. Writing a second set of headers throws inside the error handler
    // and crashes the process; destroying the socket is the only clean exit.
    if (res.headersSent) {
      logger.warn("request.error_after_headers", { route });
      return res.destroy();
    }

    if (error.details?.retryAfterSeconds) {
      res.set("Retry-After", String(error.details.retryAfterSeconds));
    }

    const body = errorEnvelope(error, traceId);

    // Development convenience only. Gated on config, never on NODE_ENV read
    // here, so the decision stays in one place and cannot be flipped by an
    // environment that was set wrong.
    if (exposeInternals && error.cause) {
      body.error.debug = { message: error.cause.message, stack: error.cause.stack };
    }

    res.status(error.status).json(body);
  };
}

/**
 * Map framework and runtime errors to the taxonomy before they are treated as
 * internal faults. A malformed JSON body is the caller's mistake, and reporting
 * it as a 500 both misleads the client and pollutes the server-error rate that
 * alerting is built on.
 */
function normalise(err) {
  if (AppError.is(err)) return err;

  // express.json() surfaces these for unparseable or oversized bodies.
  if (err?.type === "entity.parse.failed") {
    return new AppError("Request body is not valid JSON.", ErrorKind.VALIDATION, { cause: err });
  }
  if (err?.type === "entity.too.large") {
    return new AppError("Request body is too large.", ErrorKind.PAYLOAD_TOO_LARGE, { cause: err });
  }
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    return new AppError("The request was cancelled.", ErrorKind.TIMEOUT, {
      cause: err,
      expected: true,
    });
  }
  return AppError.from(err);
}
