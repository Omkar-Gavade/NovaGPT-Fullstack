import { z } from "zod";

/**
 * The environment contract.
 *
 * Every variable the platform reads is declared here exactly once. A variable
 * that is not in this schema does not exist as far as the application is
 * concerned — that is what makes `.env.example` authoritative rather than
 * aspirational (docs/backend/13-deployment.md#rules).
 *
 * Defaults are supplied for everything that can sensibly have one, so a
 * deployment with only `MONGODB_URI` set boots and runs.
 */

const port = z.coerce.number().int().min(0).max(65535);
const duration = z.coerce.number().int().positive();
const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

export const envSchema = z.object({
  /* ---- core ---- */
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: port.default(8080),
  // 0.0.0.0 in a container is required to accept traffic from outside it;
  // 127.0.0.1 would make the process unreachable through the port mapping.
  HOST: z.string().min(1).default("0.0.0.0"),
  PUBLIC_URL: z.string().url().optional(),

  /* ---- logging ---- */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  // Pretty output is for humans reading a terminal. Production emits one JSON
  // object per line so an aggregator can index the fields.
  LOG_PRETTY: bool.optional(),

  /* ---- persistence ---- */
  // Required, but never blocks startup: the connection is established in the
  // background so a database outage cannot take down stateless routes
  // (docs/backend/13-deployment.md#degradation-matrix).
  MONGODB_URI: z.string().min(1),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: duration.default(5000),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),

  /* ---- cache ---- */
  // Optional by design. Absent, the platform uses an in-process cache and is
  // correct for a single instance; it is required for more than one
  // (docs/backend/15-decisions.md#adr-014--redis-is-required-for-horizontal-scaling).
  REDIS_URL: z.string().min(1).optional(),
  REDIS_CONNECT_TIMEOUT_MS: duration.default(5000),
  REDIS_KEY_PREFIX: z.string().default("nova:"),

  /* ---- http ---- */
  BODY_LIMIT: z.string().default("1mb"),
  CORS_ORIGINS: z.string().default("*"),
  // Ceiling for a single request. Long generations are the reason this is
  // minutes rather than seconds (docs/backend/04-router.md#timeout-handling).
  REQUEST_TIMEOUT_MS: duration.default(300_000),

  /* ---- observability ---- */
  METRICS_ENABLED: bool.default(true),
  METRICS_PATH: z.string().startsWith("/").default("/api/v1/admin/metrics"),
  // Collects CPU, heap, event-loop lag. Event-loop lag is the Node-specific
  // vital sign (docs/backend/11-observability.md#health-dashboard--is-the-system-healthy).
  METRICS_DEFAULT_LABELS: z.string().optional(),

  /* ---- providers ---- */
  // Comma-separated allowlist. Empty means "every discovered adapter is
  // eligible" — a provider is enabled by having a credential, not by being
  // named here. An allowlist is the exception, for a deployment that wants to
  // pin exactly which providers may run.
  PROVIDERS_ENABLED: z.string().optional(),
  // Comma-separated denylist, applied after the allowlist. Exists so an
  // operator can take a provider out of rotation with an env change and a
  // restart, without editing an allowlist that then has to be maintained.
  PROVIDERS_DISABLED: z.string().optional(),
  // Recovery polling. Only ever probes providers that are *not* healthy, so
  // this is not a per-provider request rate
  // (docs/backend/03-provider-system.md#health-system).
  PROVIDER_HEALTH_INTERVAL_MS: duration.default(60_000),
  // A probe is a liveness sample, not work. Independent of, and far shorter
  // than, any completion timeout.
  PROVIDER_PROBE_TIMEOUT_MS: duration.default(8000),
  // Consecutive transient failures before the breaker opens. `quota` and
  // `auth` ignore this and open on the first failure.
  PROVIDER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),

  /* ---- lifecycle ---- */
  // Covers most in-flight requests without making deploys slow. Some long
  // generations will always exceed any grace period
  // (docs/backend/13-deployment.md#graceful-shutdown).
  SHUTDOWN_GRACE_MS: duration.default(30_000),
  // Delay between flipping readiness to false and closing the listener, so a
  // load balancer notices before connections start being refused.
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(5000),

  /* ---- build metadata, injected by CI ---- */
  SERVICE_NAME: z.string().default("novagpt-backend"),
  SERVICE_VERSION: z.string().default("0.0.0-dev"),
  GIT_COMMIT: z.string().default("unknown"),
  BUILD_TIME: z.string().optional(),
});

/** @typedef {z.infer<typeof envSchema>} Env */
