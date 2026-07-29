import { routeLabel } from "../routeLabel.js";

/**
 * One log line per completed request.
 *
 * Emitted on `finish` rather than at the start: a start line doubles log volume
 * to record something the completion line already implies, and it cannot carry
 * the status or duration that make the line useful.
 *
 * Level follows outcome, not status alone. A 429 is normal operation on a
 * rate-limited platform; logging it at error level trains operators to ignore
 * errors, which is how the one genuine error gets missed
 * (docs/backend/11-observability.md#levels-with-explicit-criteria).
 */
export function requestLogger({ logger, clock }) {
  return function requestLoggerMiddleware(req, res, next) {
    const started = clock.now();

    res.on("finish", () => {
      const durationMs = clock.now() - started;
      const fields = {
        method: req.method,
        route: routeLabel(req),
        status: res.statusCode,
        durationMs,
      };

      if (res.statusCode >= 500) logger.error("request.failed", fields);
      else if (res.statusCode >= 400) logger.warn("request.rejected", fields);
      else logger.info("request.completed", fields);
    });

    // Distinct from `finish`: the response never completed because the client
    // went away. Not an error — but invisible if only `finish` is observed,
    // and client disconnects are exactly what a streaming platform must see.
    res.on("close", () => {
      if (!res.writableEnded) {
        logger.info("request.aborted", {
          method: req.method,
          route: routeLabel(req),
          durationMs: clock.now() - started,
        });
      }
    });

    next();
  };
}
