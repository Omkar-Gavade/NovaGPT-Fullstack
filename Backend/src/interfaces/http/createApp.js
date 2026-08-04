import express from "express";
import cors from "cors";
import { requestContext } from "./middleware/requestContext.js";
import { tracing } from "./middleware/tracing.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { requestMetrics } from "./middleware/requestMetrics.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { healthController } from "./controllers/healthController.js";
import { metricsController } from "./controllers/metricsController.js";
import { chatController } from "./controllers/chatController.js";
import { threadController, shareController } from "./controllers/threadController.js";
import { catalogController } from "./controllers/catalogController.js";
import { authController } from "./controllers/authController.js";
import { userKeyController } from "./controllers/userKeyController.js";
import { capabilityController } from "./controllers/capabilityController.js";
import { authenticate, requireAuth, requirePermission } from "./middleware/authenticate.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { Permission } from "../../domain/identity/Role.js";

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
export function createApp({ config, logger, metrics, clock, tracer, useCases, services, security }) {
  // The product API cannot be mounted without the security collaborators.
  // Making this a hard failure rather than an `if` means there is no
  // configuration, test harness, or refactor that can serve conversations with
  // authentication quietly absent (docs/backend/10-security.md#authorization).
  if (services && !security) {
    throw new Error("createApp: the product API requires `security` to be wired");
  }

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
  // 1b. The root span, opened here so every later span nests under it and so a
  //     body-parse failure is still a timed, traceable request.
  if (tracer) app.use(tracing({ tracer }));
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

  // Product API, versioned. Everything here is v1 and moves together
  // (docs/backend/09-api-design.md#versioning).
  if (services) {
    const { tokenService, users, limiter, rules, authService } = security;

    const v1 = express.Router();

    // 3a. Identify the caller before any route runs. This never refuses a
    //     request — it only establishes `req.principal`, so a public route
    //     still serves a client holding an expired token. Refusal is per
    //     route, below (docs/backend/10-security.md#authorization).
    v1.use(authenticate({ tokenService, users, logger }));

    // Auth endpoints carry their own per-IP limit, which fails closed.
    v1.use(authController({ authService, limiter, rules, config, metrics }));

    // Public: the catalog and a shared conversation. A share link *is* the
    // grant, so requiring an account to open one would break every link that
    // has already been sent.
    //
    // Limits are handed to the controllers rather than mounted here, because a
    // middleware mounted at the router level also runs for the requests that
    // *fall through* to a later controller — which would charge every chat call
    // against the anonymous budget as well as its own.
    v1.use(
      catalogController({
        catalogService: services.catalog,
        limit: rateLimit({ limiter, rules: rules.anonymous, subject: "user", metrics }),
      })
    );
    v1.use(shareController({ threadService: services.threads }));

    // The gate. Everything mounted below it touches a conversation; everything
    // above it is deliberately public and has already been handled by the time
    // this runs. `AUTH_REQUIRED=false` is the single-user local mode, and
    // configuration validation refuses it in production.
    if (config.auth.required) v1.use(requireAuth({ metrics }));

    v1.use(
      chatController({
        orchestrator: services.chat,
        logger,
        limit: rateLimit({
          limiter,
          rules: [rules.chatMinute, rules.chatHour],
          subject: "user",
          metrics,
        }),
      })
    );
    v1.use(threadController({ threadService: services.threads, config }));

    // Tools and embeddings, with their own tighter limit.
    if (services.capability) {
      v1.use(
        capabilityController({
          capabilityService: services.capability,
          userKeyService: security.userKeyService,
          limit: rateLimit({ limiter, rules: rules.capability, subject: "user", metrics }),
        })
      );
    }
    // Behind the same gate: a provider key belongs to an account, so there is
    // no anonymous form of this.
    if (security.userKeyService) {
      v1.use(userKeyController({ userKeyService: security.userKeyService, metrics }));
    }

    app.use("/api/v1", v1);
  }

  if (config.metrics.enabled) {
    // Metrics expose route names, provider identities and traffic shape — an
    // operator surface, not a public one. Protected by permission when the
    // security layer is wired; the platform-only harness has no accounts and
    // mounts it bare (docs/backend/10-security.md#roles).
    const guard = security
      ? [
          authenticate({ tokenService: security.tokenService, users: security.users, logger }),
          requirePermission(Permission.ADMIN_METRICS, { metrics }),
        ]
      : [];
    app.use(config.metrics.path, ...guard, metricsController({ metrics, logger }));
  }

  // 4. Terminal handlers, in this order: unmatched routes become a domain
  //    error, and the error handler is the single place that writes an error
  //    response.
  app.use(notFound());
  app.use(errorHandler({ logger, metrics, exposeInternals: !config.isProduction }));

  return app;
}
