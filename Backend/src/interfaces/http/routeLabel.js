/**
 * The route *pattern* a request matched, for use as a metric or log label.
 *
 * Never the raw URL. `/api/v1/threads/01HQ8X…` as a label would create one time
 * series per thread, which is the textbook way to make a metrics backend
 * expensive and slow (docs/backend/11-observability.md#cardinality-discipline).
 * `/api/v1/threads/:threadId` is one series regardless of traffic.
 *
 * Unmatched requests collapse to a single `unmatched` label rather than
 * reporting their path: a scanner probing thousands of random URLs would
 * otherwise mint a time series per probe — a cardinality attack that needs no
 * authentication.
 */
export function routeLabel(req) {
  const pattern = req.route?.path;
  if (!pattern) return "unmatched";
  const base = req.baseUrl ?? "";
  const combined = `${base}${pattern === "/" ? "" : pattern}`;
  return combined === "" ? "/" : combined;
}

/**
 * Status collapsed to its class (`2xx`, `4xx`, …).
 *
 * Individual codes multiply series for a distinction dashboards rarely draw;
 * the exact code is in the logs when it is needed.
 */
export function statusClass(status) {
  if (typeof status !== "number" || status < 100 || status > 599) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}
