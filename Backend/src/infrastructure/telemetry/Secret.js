const VALUE = Symbol("secret.value");

/**
 * A credential that cannot be logged by accident.
 *
 * This is the highest-value leak defence in the system, because it makes the
 * *default* behaviour safe. Every other control (redaction filters, response
 * allowlists, secret scanning) catches a leak at one specific point and depends
 * on someone remembering. A developer who does the naive thing here —
 * `log.info("boot", { uri: config.mongo.uri })` or a template literal — gets
 * `[REDACTED:MONGODB_URI]`, not a password
 * (docs/backend/10-security.md#structural-defences-against-leakage-t1).
 *
 * The value is reachable only through `.expose()`, which is greppable: a review
 * can ask "why does this line expose a secret?" and get a real answer.
 */
export class Secret {
  /**
   * @param {string} value
   * @param {string} [label] variable name, shown in the redaction so a
   *                         misconfiguration is still diagnosable
   */
  constructor(value, label = "secret") {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Secret ${label} must be a non-empty string`);
    }
    Object.defineProperty(this, VALUE, { value, enumerable: false, writable: false });
    this.label = label;
    Object.freeze(this);
  }

  /** The only way to read the value. Deliberately verbose at the call site. */
  expose() {
    return this[VALUE];
  }

  get redacted() {
    return `[REDACTED:${this.label}]`;
  }

  toString() {
    return this.redacted;
  }

  toJSON() {
    return this.redacted;
  }

  /** `console.log` and `util.inspect` route through this. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.redacted;
  }

  /** String coercion in template literals and concatenation. */
  [Symbol.toPrimitive]() {
    return this.redacted;
  }

  static is(value) {
    return value instanceof Secret;
  }
}
