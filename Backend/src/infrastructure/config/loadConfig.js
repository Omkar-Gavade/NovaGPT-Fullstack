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
    }),

    mongo: Object.freeze({
      // Wrapped: a connection string carries credentials, so accidental
      // interpolation into a log line must produce a redaction, not a password
      // (docs/backend/10-security.md#structural-defences-against-leakage-t1).
      uri: new Secret(env.MONGODB_URI, "MONGODB_URI"),
      serverSelectionTimeoutMs: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    }),

    redis: Object.freeze({
      enabled: Boolean(env.REDIS_URL),
      url: env.REDIS_URL ? new Secret(env.REDIS_URL, "REDIS_URL") : null,
      connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
      keyPrefix: env.REDIS_KEY_PREFIX,
    }),

    providers: Object.freeze({
      // `null` means "no allowlist", which is different from "an empty
      // allowlist". Collapsing the two would make an empty variable silently
      // disable every provider.
      allowlist: parseList(env.PROVIDERS_ENABLED),
      denylist: parseList(env.PROVIDERS_DISABLED) ?? [],
      healthIntervalMs: env.PROVIDER_HEALTH_INTERVAL_MS,
      probeTimeoutMs: env.PROVIDER_PROBE_TIMEOUT_MS,
      failureThreshold: env.PROVIDER_FAILURE_THRESHOLD,
    }),

    metrics: Object.freeze({
      enabled: env.METRICS_ENABLED,
      path: env.METRICS_PATH,
      defaultLabels: parseLabels(env.METRICS_DEFAULT_LABELS),
    }),

    shutdown: Object.freeze({
      graceMs: env.SHUTDOWN_GRACE_MS,
      drainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    }),
  });
}

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
