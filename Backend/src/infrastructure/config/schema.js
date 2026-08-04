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

  /* ---- persistence ---- */
  // Runs the in-process repository instead of Mongo. For local development and
  // tests only — conversations do not survive the process.
  PERSISTENCE_IN_MEMORY: bool.default(false),

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

  // Prompt and completion text in the logs. **Off, and it stays off unless an
  // operator turns it on deliberately** — at which point the decision is
  // written to the audit log, because a config flag someone flips and forgets
  // is the difference between a debugging tool and a liability
  // (docs/backend/11-observability.md#what-is-never-logged).
  LOG_CONTENT: bool.default(false),

  /* ---- tracing (docs/backend/11-observability.md#tracing) ---- */
  TRACING_ENABLED: bool.default(true),
  // The fraction of *ordinary successful* requests kept. Errors, failovers and
  // slow requests are kept at 100% regardless — sampling those away defeats the
  // reason traces exist.
  TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  // At or above this, a request is "slow" and kept in full. A fixed threshold
  // rather than a live p95, because a percentile computed from the traces you
  // kept is circular.
  TRACE_SLOW_MS: duration.default(5000),
  // Bounds one trace. A retry storm must not be able to grow a trace without
  // limit; dropped spans are counted so the trace says it is incomplete.
  TRACE_MAX_SPANS: z.coerce.number().int().min(10).max(2000).default(200),

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

  /* ---- routing (docs/backend/04-router.md) ---- */
  // One primary plus two fallbacks. Beyond three, the cause is almost never
  // provider-specific, and every extra attempt burns a scarce quota unit on a
  // request that will not succeed.
  ROUTING_MAX_CANDIDATES: z.coerce.number().int().min(1).max(10).default(3),
  ROUTING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Retries against the *same* provider, before failing over.
  ROUTING_MAX_RETRIES_PER_PROVIDER: z.coerce.number().int().min(0).max(5).default(2),
  ROUTING_RETRY_BASE_MS: duration.default(300),
  ROUTING_RETRY_MAX_MS: duration.default(4000),
  // Budget for one provider attempt: generous for a slow provider, short
  // enough to leave room for a failover inside the overall budget.
  ROUTING_ATTEMPT_TIMEOUT_MS: duration.default(60_000),
  // Budget across every attempt. Deliberately below REQUEST_TIMEOUT_MS so the
  // router fails cleanly with a useful message before the transport gives up.
  ROUTING_OVERALL_TIMEOUT_MS: duration.default(120_000),
  // Operator bias, `provider=weight` pairs. A bias, never an override: it
  // cannot make an unhealthy or incapable provider eligible.
  ROUTING_PRIORITIES: z.string().optional(),

  /* ---- authentication (docs/backend/10-security.md#authentication) ---- */
  // When false, unauthenticated callers keep full access as the anonymous
  // principal — a single-user local mode. It defaults to **on**, and turning it
  // off is announced loudly at boot: a security control that silently defaults
  // to off is not a control.
  AUTH_REQUIRED: bool.default(true),
  AUTH_ALLOW_REGISTRATION: bool.default(true),
  // RS256 key pair, PEM. Absent outside production, an ephemeral pair is
  // generated at boot — which invalidates every token on restart and cannot be
  // shared between instances, so production requires real keys.
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  // Accepted but not used for signing, so a key rotation does not invalidate
  // every token in flight (docs/backend/10-security.md#rotation).
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  JWT_ISSUER: z.string().min(1).default("novagpt"),
  JWT_AUDIENCE: z.string().min(1).default("novagpt-api"),
  // Short enough that a stolen token expires before it is worth much, long
  // enough to avoid a refresh on every other request.
  AUTH_ACCESS_TTL_MS: duration.default(900_000),
  AUTH_REFRESH_TTL_MS: duration.default(30 * 24 * 60 * 60 * 1000),
  AUTH_COOKIE_NAME: z.string().min(1).default("nova_refresh"),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  // Defaults to on in production. Off is for plain-HTTP local development only;
  // a Secure cookie is never sent over HTTP, so the flow would silently fail.
  AUTH_COOKIE_SECURE: bool.optional(),
  // Length beats composition rules: `Passw0rd!` satisfies every class
  // requirement and is weaker than a longer passphrase.
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(12),
  // Escalating backoff, not a hard lock: a permanent lock hands an attacker a
  // denial-of-service primitive against any address they know.
  LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(1).max(50).default(5),
  LOGIN_LOCKOUT_BASE_MS: duration.default(30_000),
  LOGIN_LOCKOUT_MAX_MS: duration.default(900_000),
  // 32 bytes, base64. Wraps the per-record data keys that encrypt user-supplied
  // provider keys (docs/backend/10-security.md#envelope-encryption-for-user-keys).
  ENCRYPTION_MASTER_KEY: z.string().optional(),

  /* ---- rate limiting (docs/backend/10-security.md#rate-limiting) ---- */
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_CHAT_PER_HOUR: z.coerce.number().int().min(1).default(300),

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
