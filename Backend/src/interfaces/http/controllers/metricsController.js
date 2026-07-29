import { Router } from "express";

/**
 * Prometheus exposition endpoint.
 *
 * Not mounted at all when metrics are disabled, rather than mounted and
 * returning an error: an endpoint that exists but refuses is a scrape target
 * that alerts on itself.
 *
 * Access control is deliberately absent in this phase. Metrics reveal traffic
 * shape, error rates, and dependency health — operational intelligence that
 * should not be public — so the endpoint MUST be reachable only from inside the
 * deployment network until admin authentication lands in Phase 6
 * (docs/backend/14-roadmap.md#phase-6--security-and-authentication). This is
 * recorded as a known gap rather than papered over with a shared token that
 * would then never be replaced.
 */
export function metricsController({ metrics, logger }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const body = await metrics.render();
      res.set("Content-Type", metrics.contentType());
      res.set("Cache-Control", "no-store");
      res.send(body);
    } catch (error) {
      // Telemetry failing must never look like the service failing, but the
      // scrape does need to fail so the gap is visible rather than silent.
      logger.error("metrics.render_failed", { error });
      next(error);
    }
  });

  return router;
}
