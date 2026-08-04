import { envSchema } from "./schema.js";
import { Secret } from "../telemetry/Secret.js";

/**
 * Validate the environment and build the typed configuration object.
 *
 * This module and `main.js` are the only places allowed to read `process.env`
 * (docs/backend/02-architecture.md#enforcement). Everything downstream receives
 * the object this returns, which is why config is testable without mutating
 * global state.
 */

export class ConfigError extends Error {
  constructor(issues) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * @param {Record<string, string|undefined>} [source] defaults to process.env
 * @returns {Config}
 */
export function loadConfig(source = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Report every problem at once. Fixing one variable per restart is a
    // miserable loop when a fresh deployment is missing four of them.
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const env = result.data;
  const isProduction = env.NODE_ENV === "production";

  // Cross-field rules the schema cannot express, checked before anything is
  // built. Failing here names the variable and never prints a value.
  const crossFieldIssues = validateSecurity(env, isProduction);
  if (crossFieldIssues.length) throw new ConfigError(crossFieldIssues);

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction,
    isTest: env.NODE_ENV === "test",

    service: Object.freeze({
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      commit: env.GIT_COMMIT,
      builtAt: env.BUILD_TIME ?? null,
    }),

    http: Object.freeze({
      host: env.HOST,
      port: env.PORT,
      publicUrl: env.PUBLIC_URL ?? null,
      bodyLimit: env.BODY_LIMIT,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      corsOrigins: parseOrigins(env.CORS_ORIGINS),
    }),

    log: Object.freeze({
      level: env.LOG_LEVEL,
      // Human-readable output defaults on outside production and off inside it,
      // so neither environment needs to remember to set it.
      pretty: env.LOG_PRETTY ?? !isProduction,
      // Never defaulted on by any environment. The only way this is true is an
      // operator setting it, and that action is audited at boot.
      content: env.LOG_CONTENT,
    }),

    mongo: Object.freeze({
      // Wrapped: a connection string carries credentials, so accidental
      // interpolation into a log line must produce a redaction, not a password
      // (docs/backend/10-security.md#structural-defences-against-leakage-t1).
      uri: new Secret(env.MONGODB_URI, "MONGODB_URI"),
      serverSelectionTimeoutMs: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    }),

    persistence: Object.freeze({
      inMemory: env.PERSISTENCE_IN_MEMORY,
    }),

    redis: Object.freeze({
      enabled: Boolean(env.REDIS_URL),
      url: env.REDIS_URL ? new Secret(env.REDIS_URL, "REDIS_URL") : null,
      connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
      keyPrefix: env.REDIS_KEY_PREFIX,
    }),

    attachments: Object.freeze({
      allowedHosts: parseList(env.ATTACHMENT_ALLOWED_HOSTS) ?? [],
      maxBytes: env.ATTACHMENT_MAX_BYTES,
      maxCount: env.ATTACHMENT_MAX_COUNT,
      maxTotalBytes: env.ATTACHMENT_MAX_TOTAL_BYTES,
      fetchTimeoutMs: env.ATTACHMENT_FETCH_TIMEOUT_MS,
    }),

    tracing: Object.freeze({
      enabled: env.TRACING_ENABLED,
      sampleRate: env.TRACE_SAMPLE_RATE,
      slowThresholdMs: env.TRACE_SLOW_MS,
      maxSpansPerTrace: env.TRACE_MAX_SPANS,
    }),

    providers: Object.freeze({
      // `null` means "no allowlist", which is different from "an empty
      // allowlist". Collapsing the two would make an empty variable silently
      // disable every provider.
      allowlist: parseList(env.PROVIDERS_ENABLED),
      denylist: parseList(env.PROVIDERS_DISABLED) ?? [],
      dark: parseList(env.PROVIDERS_DARK) ?? [],
      darkSince: parseLabels(env.PROVIDERS_DARK_SINCE),
      healthIntervalMs: env.PROVIDER_HEALTH_INTERVAL_MS,
      probeTimeoutMs: env.PROVIDER_PROBE_TIMEOUT_MS,
      failureThreshold: env.PROVIDER_FAILURE_THRESHOLD,
    }),

    routing: Object.freeze({
      maxCandidates: env.ROUTING_MAX_CANDIDATES,
      maxAttempts: env.ROUTING_MAX_ATTEMPTS,
      maxRetriesPerProvider: env.ROUTING_MAX_RETRIES_PER_PROVIDER,
      retryBaseDelayMs: env.ROUTING_RETRY_BASE_MS,
      retryMaxDelayMs: env.ROUTING_RETRY_MAX_MS,
      attemptTimeoutMs: env.ROUTING_ATTEMPT_TIMEOUT_MS,
      overallTimeoutMs: env.ROUTING_OVERALL_TIMEOUT_MS,
      priorities: parseWeights(env.ROUTING_PRIORITIES),
    }),

    metrics: Object.freeze({
      enabled: env.METRICS_ENABLED,
      path: env.METRICS_PATH,
      defaultLabels: parseLabels(env.METRICS_DEFAULT_LABELS),
    }),

    auth: Object.freeze({
      required: env.AUTH_REQUIRED,
      allowRegistration: env.AUTH_ALLOW_REGISTRATION,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlMs: env.AUTH_ACCESS_TTL_MS,
      refreshTtlMs: env.AUTH_REFRESH_TTL_MS,
      // Wrapped: a private key interpolated into a log line must produce a
      // redaction, not a signing key.
      privateKey: env.JWT_PRIVATE_KEY ? new Secret(unescapePem(env.JWT_PRIVATE_KEY), "JWT_PRIVATE_KEY") : null,
      // Public keys are not secrets and are deliberately not wrapped — wrapping
      // a non-secret trains readers to `.expose()` without thinking.
      publicKey: env.JWT_PUBLIC_KEY ? unescapePem(env.JWT_PUBLIC_KEY) : null,
      previousPublicKey: env.JWT_PREVIOUS_PUBLIC_KEY
        ? unescapePem(env.JWT_PREVIOUS_PUBLIC_KEY)
        : null,
      cookie: Object.freeze({
        name: env.AUTH_COOKIE_NAME,
        domain: env.AUTH_COOKIE_DOMAIN ?? null,
        secure: env.AUTH_COOKIE_SECURE ?? isProduction,
      }),
      password: Object.freeze({ minLength: env.PASSWORD_MIN_LENGTH }),
      lockout: Object.freeze({
        threshold: env.LOGIN_LOCKOUT_THRESHOLD,
        baseDelayMs: env.LOGIN_LOCKOUT_BASE_MS,
        maxDelayMs: env.LOGIN_LOCKOUT_MAX_MS,
      }),
      encryptionKey: env.ENCRYPTION_MASTER_KEY
        ? new Secret(env.ENCRYPTION_MASTER_KEY, "ENCRYPTION_MASTER_KEY")
        : null,
    }),

    rateLimit: Object.freeze({
      anonymousPerMinute: env.RATE_LIMIT_ANONYMOUS_PER_MINUTE,
      authPerMinute: env.RATE_LIMIT_AUTH_PER_MINUTE,
      chatPerMinute: env.RATE_LIMIT_CHAT_PER_MINUTE,
      chatPerHour: env.RATE_LIMIT_CHAT_PER_HOUR,
    }),

    shutdown: Object.freeze({
      graceMs: env.SHUTDOWN_GRACE_MS,
      drainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    }),
  });
}

/**
 * Security settings that only make sense together.
 *
 * All of these are production-only requirements, and all of them fail at boot
 * rather than at the first request. A deployment that starts and then rejects
 * every login is far harder to diagnose than one that refuses to start and says
 * which variable is missing (docs/backend/13-deployment.md#rules).
 */
function validateSecurity(env, isProduction) {
  const issues = [];
  if (!isProduction) return issues;

  if (!env.JWT_PRIVATE_KEY || !env.JWT_PUBLIC_KEY) {
    issues.push(
      "JWT_PRIVATE_KEY/JWT_PUBLIC_KEY: required in production. An ephemeral key pair " +
        "invalidates every token on restart and cannot be shared between instances."
    );
  }
  if (!env.AUTH_REQUIRED) {
    issues.push(
      "AUTH_REQUIRED: cannot be disabled in production — it would leave every " +
        "conversation endpoint open to unauthenticated callers."
    );
  }
  if (env.CORS_ORIGINS.trim() === "*") {
    issues.push(
      "CORS_ORIGINS: a wildcard is not permitted in production; list the origins that " +
        "may call this API."
    );
  }
  return issues;
}

/**
 * PEM keys in environment variables arrive with literal `\n` sequences, because
 * most secret stores and CI systems cannot carry a real newline in a variable.
 * Without this, every key is rejected as malformed with no useful message.
 */
const unescapePem = (value) => value.replace(/\\n/g, "\n").trim();

/** `*` means allow any origin; anything else is a comma-separated allowlist. */
function parseOrigins(raw) {
  const trimmed = raw.trim();
  if (trimmed === "*") return "*";
  return Object.freeze(
    trimmed
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
}

/**
 * Comma-separated list, or `null` when the variable is absent.
 *
 * The null-vs-empty distinction is load-bearing for the provider allowlist:
 * absent means "no restriction", while an explicitly empty list would mean
 * "permit nothing".
 */
function parseList(raw) {
  if (raw === undefined || raw === null) return null;
  return Object.freeze(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

/** `provider=weight` pairs -> numeric map. Non-numeric weights are dropped. */
function parseWeights(raw) {
  const out = {};
  for (const [key, value] of Object.entries(parseLabels(raw))) {
    const weight = Number(value);
    if (Number.isFinite(weight)) out[key] = weight;
  }
  return Object.freeze(out);
}

/** `key=value,key=value` -> object. Malformed pairs are dropped, not fatal. */
function parseLabels(raw) {
  if (!raw) return Object.freeze({});
  const out = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    const value = rest.join("=").trim();
    if (key?.trim() && value) out[key.trim()] = value;
  }
  return Object.freeze(out);
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
