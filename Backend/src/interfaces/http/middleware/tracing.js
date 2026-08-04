import { routeLabel } from "../routeLabel.js";

/**
 * Open the root span for a request, and hold it open until the response ends.
 *
 * The span deliberately outlives `next()`. Ending it when the middleware chain
 * returns would time how long it took to *start* handling the request —
 * microseconds — rather than the seconds a streaming generation actually runs
 * for, which is the number the trace exists to explain.
 *
 * It resolves rather than rejects on failure. A rejected root span would end
 * the trace before the error handler had written the response, so the status
 * code — the thing an operator scans for first — would be missing from it.
 */
export function tracing({ tracer }) {
  return function tracingMiddleware(req, res, next) {
    tracer
      .span(
        "http.request",
        (span) =>
          new Promise((resolve) => {
            // `close` as well as `finish`: a client that disconnects mid-stream
            // never emits `finish`, and that trace is one of the more
            // interesting ones the system produces.
            const done = () => {
              span?.setAttributes({
                "http.route": routeLabel(req),
                "http.status_code": res.statusCode,
                // Only meaningful for a stream, and the reason a cancelled
                // request is distinguishable from a completed one.
                "http.completed": res.writableEnded,
              });
              // The status is left as an *attribute* rather than ending the
              // span here: ending it early would freeze the duration at the
              // wrong moment and make the tracer's own `end` a no-op. The
              // sampler reads the attribute instead.
              resolve();
            };
            res.once("finish", done);
            res.once("close", done);
            next();
          }),
        {
          "http.method": req.method,
          // The *pattern*, never the concrete path: a path with an id in it is
          // an unbounded attribute value.
          "http.route": routeLabel(req),
        }
      )
      .catch(() => {
        /* the span is already closed; nothing here may affect the response */
      });
  };
}
