import { redact } from "./redact.js";
import { contextFields } from "./traceContext.js";

/**
 * Structured JSON logger implementing LoggerPort.
 *
 * Written rather than adopted, for one reason: redaction is a security control
 * here (docs/backend/10-security.md, T1 and T13), and a control that matters
 * that much should be code we own and test directly rather than a serialiser
 * configured onto someone else's pipeline. The whole implementation is small
 * enough to read in one sitting, which is itself the point.
 *
 * Emits one JSON object per line. Logs are read by machines far more often than
 * by people, and `grep` over prose breaks whenever the wording changes.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export class Logger {
  /**
   * @param {object} options
   * @param {string} [options.level]
   * @param {boolean} [options.pretty]
   * @param {object} [options.base]     fields on every line
   * @param {NodeJS.WriteStream} [options.stream]
   * @param {() => number} [options.now]
   */
  constructor({ level = "info", pretty = false, base = {}, stream, now } = {}) {
    this.threshold = LEVELS[level] ?? LEVELS.info;
    this.level = level;
    this.pretty = pretty;
    this.base = base;
    this.stream = stream ?? process.stdout;
    this.now = now ?? Date.now;
  }

  /** A logger with extra fields bound. Shares the parent's stream and level. */
  child(bindings = {}) {
    return new Logger({
      level: this.level,
      pretty: this.pretty,
      base: { ...this.base, ...bindings },
      stream: this.stream,
      now: this.now,
    });
  }

  debug(event, fields) {
    this.#write("debug", event, fields);
  }

  info(event, fields) {
    this.#write("info", event, fields);
  }

  warn(event, fields) {
    this.#write("warn", event, fields);
  }

  error(event, fields) {
    this.#write("error", event, fields);
  }

  #write(level, event, fields) {
    if (LEVELS[level] < this.threshold) return;

    const record = {
      level,
      time: new Date(this.now()).toISOString(),
      event,
      ...this.base,
      ...contextFields(),
      ...redact(fields ?? {}),
    };

    try {
      this.stream.write(`${this.pretty ? format(record) : JSON.stringify(record)}\n`);
    } catch {
      // A logger that throws takes down the request it was describing. Losing
      // one line is strictly better than losing the response.
    }
  }
}

const COLOUR = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

/** Terminal-friendly rendering. Development only — never parsed by anything. */
function format(record) {
  const { level, time, event, ...rest } = record;
  const stamp = time.slice(11, 23);
  const head = `${COLOUR[level] ?? ""}${level.toUpperCase().padEnd(5)}${RESET}`;
  const keys = Object.keys(rest);
  if (keys.length === 0) return `${stamp} ${head} ${event}`;
  const tail = keys
    .map((k) => `${k}=${typeof rest[k] === "object" ? JSON.stringify(rest[k]) : rest[k]}`)
    .join(" ");
  return `${stamp} ${head} ${event} ${tail}`;
}

/** Discards everything. For tests that exercise code paths which log. */
export const silentLogger = new Logger({ level: "silent" });
