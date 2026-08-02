import { Secret } from "./Secret.js";

/**
 * Second line of defence: scrub credentials from log fields.
 *
 * `Secret` handles values we knew were sensitive. This handles the ones that
 * arrived from somewhere we did not control — an upstream error body, a header
 * bag, a config object someone spread into a log call.
 *
 * Two independent strategies, because either alone has a blind spot:
 *   - by key name, which catches a credential whose *format* we do not know
 *   - by value shape, which catches a credential under an innocent key name
 */

/** Words that mark a field as a credential. Matched per word, not per substring. */
const SENSITIVE_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "session",
  "signature",
  "private",
]);

/**
 * Split a field name into words across camelCase and separators, so
 * `sessionToken`, `session_token`, and `SESSION-TOKEN` all match, while
 * `tokenizer`, `keyboard`, and `monkey` do not.
 *
 * Substring matching would redact `monkey` (contains "key") and miss
 * `sessionToken` unless it also matched mid-word — the two failure modes are
 * opposite, and only word splitting avoids both.
 */
function isSensitiveKey(key) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-/]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((word) => SENSITIVE_WORDS.has(word));
}

/**
 * Value shapes that are credentials regardless of the key they sit under.
 * The replacement is declared alongside the pattern rather than inferred, so a
 * pattern needing custom handling cannot silently fall back to the default.
 */
const SENSITIVE_VALUE = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g }, // OpenAI-style
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g }, // Google
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g }, // Groq
  { pattern: /\bhf_[A-Za-z0-9]{20,}/g }, // Hugging Face
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g }, // GitHub
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi }, // any bearer token
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g }, // JWT
  {
    // Credentials in a connection string: mongodb://user:pass@host.
    // Scheme and host are preserved so the log still says which database
    // failed; only the userinfo is destroyed.
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^:@/\s]+:[^@/\s]+@/gi,
    replace: (_match, scheme) => `${scheme}://${REDACTED}@`,
  },
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/** Scrub credential shapes out of a string. */
export function redactString(input) {
  if (typeof input !== "string") return input;
  let out = input;
  for (const { pattern, replace } of SENSITIVE_VALUE) {
    out = out.replace(pattern, replace ?? REDACTED);
  }
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

/**
 * Deep-scrub a value for logging.
 *
 * Also handles the structural hazards of serialising arbitrary objects: cycles,
 * unbounded depth, Errors (which do not JSON-serialise), and BigInt (which
 * throws). A logger that can throw is a logger that takes down the request it
 * was describing.
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (Secret.is(value)) return value.redacted;
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === "string") return redactString(value);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return `${value}n`;
  if (type === "function") return "[Function]";
  if (type === "symbol") return value.toString();

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value, depth, seen);

  if (depth >= MAX_DEPTH) return "[Object]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Map) {
    return redact(Object.fromEntries(value), depth, seen);
  }
  if (value instanceof Set) {
    return redact([...value], depth, seen);
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, depth + 1, seen);
  }
  return out;
}

/**
 * Errors serialise to `{}` by default because their fields are non-enumerable,
 * which is how "an error occurred: {}" ends up in production logs.
 */
function redactError(error, depth, seen) {
  const out = {
    name: error.name,
    message: redactString(error.message),
  };
  if (error.stack) out.stack = redactString(error.stack);
  if (error.kind) out.kind = error.kind;
  if (error.failureKind) out.failureKind = error.failureKind;
  if (error.provider) out.provider = error.provider;
  if (error.code) out.code = error.code;
  if (error.cause && depth < MAX_DEPTH) {
    out.cause = redact(error.cause, depth + 1, seen);
  }
  return out;
}
