import { Router } from "express";

/**
 * Health, readiness, liveness and version.
 *
 * Unversioned: these are consumed by infrastructure — orchestrators, load
 * balancers, uptime checks — not by API clients, and they must never break
 * (docs/backend/09-api-design.md#operations).
 *
 * The router is deliberately free of business logic. Each handler calls one use
 * case and maps its result onto a status code; the interesting decisions —
 * which dependency is critical, whether draining blocks readiness — live in the
 * application layer where they are testable without HTTP.
 */
export function healthController({ checkLiveness, checkReadiness, getVersion }) {
  const router = Router();

  /**
   * Liveness. Never touches a dependency: a failing probe here means "restart
   * this process", and a database blip must not restart every healthy instance.
   */
  router.get("/live", (req, res) => {
    const result = checkLiveness.execute();
    res.status(result.alive ? 200 : 503).json(result);
  });

  /**
   * Readiness. 503 removes this instance from rotation without killing it,
   * which is what makes both graceful shutdown and a degraded-dependency window
   * survivable.
   */
  router.get("/ready", async (req, res) => {
    const result = await checkReadiness.execute();
    // Probes reflect state that changes second to second; a cached readiness
    // response is worse than none.
    res.set("Cache-Control", "no-store");
    res.status(result.ready ? 200 : 503).json(result);
  });

  /**
   * The general health endpoint: liveness semantics, plus dependency detail for
   * a human looking at one instance. Kept distinct from `/ready` so that
   * curiosity about dependencies never changes traffic routing.
   */
  router.get("/health", async (req, res) => {
    const liveness = checkLiveness.execute();
    const readiness = await checkReadiness.execute();
    res.set("Cache-Control", "no-store");
    res.status(liveness.alive ? 200 : 503).json({
      status: summarise(readiness),
      ...liveness,
      dependencies: readiness.dependencies,
    });
  });

  /** What is actually deployed here. Build metadata only, never configuration. */
  router.get("/version", (req, res) => {
    res.json(getVersion.execute());
  });

  return router;
}

/**
 * Collapse a readiness result to one word for a human.
 *
 * `ready` is checked *after* `reason`, not before. An instance with Redis down
 * is still ready — that is the documented degradation — but reporting it as
 * "ok" would hide the degradation from the one endpoint an operator opens to
 * find it. Ready and healthy are different questions.
 */
function summarise(readiness) {
  if (readiness.reason) return readiness.ready ? "degraded" : "unavailable";
  return readiness.ready ? "ok" : "starting";
}
