import { routeLabel, statusClass } from "../routeLabel.js";

/**
 * Request counters and latency histogram.
 *
 * Labels are read on `finish`, not on entry: `req.route` is only populated once
 * Express has matched a handler, so labelling early would report every request
 * as `unmatched`.
 */
export function requestMetrics({ metrics, clock }) {
  return function requestMetricsMiddleware(req, res, next) {
    const started = clock.now();

    res.on("finish", () => {
      const labels = { route: routeLabel(req), method: req.method };
      metrics.increment("nova_requests_total", {
        ...labels,
        status: statusClass(res.statusCode),
      });
      metrics.observe(
        "nova_request_duration_seconds",
        (clock.now() - started) / 1000,
        labels
      );
    });

    next();
  };
}
