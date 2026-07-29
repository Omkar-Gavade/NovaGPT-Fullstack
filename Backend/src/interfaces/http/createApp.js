import express from "express";
import cors from "cors";
import { requestContext } from "./middleware/requestContext.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { requestMetrics } from "./middleware/requestMetrics.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { healthController } from "./controllers/healthController.js";
import { metricsController } from "./controllers/metricsController.js";

/**
 * Assemble the Express application from injected collaborators.
 *
 * Takes dependencies rather than constructing them, so a test can build the
 * whole app with a fake clock, a silent logger, and no network — which is what
 * makes the HTTP layer testable without a database or a Redis
 * (docs/backend/12-testing.md#integration-testing).
 *
 * Middleware order below is load-bearing and is explained inline.
 */
export function createApp({ config, logger, metrics, clock, useCases }) {
  const app = express();

  // Trust the proxy so `req.ip` and `req.protocol` reflect the client rather
  // than the load balancer. Required for per-IP rate limiting to target a
  // caller instead of the ingress. Off outside production, where there is no
  // proxy and trusting one would let a client spoof its own address.
  app.set("trust proxy", config.isProduction ? 1 : false);

  // Advertising the framework and version tells a scanner which CVEs to try.
  app.disable("x-powered-by");
  // Strict routing off: `/health` and `/health/` are the same probe, and an
  // orchestrator configured with a trailing slash should not fail silently.
  app.set("strict routing", false);

  // 1. Correlation first, so every later line — including a body-parse failure
  //    — carries a trace id.
  app.use(requestContext());
  // 2. Metrics and logging before parsing, so a request rejected by the parser
  //    is still counted. Measuring only the requests that parsed hides exactly
  //    the failures worth knowing about.
  app.use(requestMetrics({ metrics, clock }));
  app.use(requestLogger({ logger, clock }));

  app.use(
    cors({
      origin: config.http.corsOrigins,
      // Trace headers must be readable by a browser client, otherwise a user
      // cannot report the id that makes their bug diagnosable.
      exposedHeaders: ["X-Request-Id", "X-Correlation-Id", "X-Trace-Id", "Retry-After"],
    })
  );

  // 3. Body parsing, bounded. An unbounded parser is a memory-exhaustion vector
  //    that needs no authentication.
  app.use(express.json({ limit: config.http.bodyLimit }));

  // Health endpoints are mounted at both the root and under `/api`. Root is
  // where orchestrators and uptime checks look by convention; `/api` is the
  // documented path (docs/backend/09-api-design.md#operations). One router
  // instance, two mounts — no duplicated handlers.
  const health = healthController(useCases);
  app.use("/", health);
  app.use("/api", health);

  if (config.metrics.enabled) {
    app.use(config.metrics.path, metricsController({ metrics, logger }));
  }

  // 4. Terminal handlers, in this order: unmatched routes become a domain
  //    error, and the error handler is the single place that writes an error
  //    response.
  app.use(notFound());
  app.use(errorHandler({ logger, metrics, exposeInternals: !config.isProduction }));

  return app;
}
