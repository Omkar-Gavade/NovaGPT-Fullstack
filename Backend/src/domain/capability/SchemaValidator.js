/**
 * Does the model's output actually match the schema that was asked for?
 *
 * **Providers advertise schema enforcement and do not always deliver it.** Some
 * enforce structure strictly, some treat the schema as a strong hint, some
 * ignore it under load, and every one of them will occasionally return prose
 * wrapped in a fenced code block. A client that asked for `json_schema` and
 * received a paragraph has no way to tell that apart from a bug of its own —
 * which is why the acceptance criterion is *validated server-side before it
 * reaches the client* ([14](../../../docs/backend/14-roadmap.md)).
 *
 * A deliberately small JSON Schema subset: the keywords a provider's own schema
 * support actually honours, and nothing else. `$ref`, `allOf`, `oneOf` and
 * conditionals are not implemented, because a schema using them is a schema no
 * provider enforces either — accepting one here would mean validating against a
 * contract the model was never given.
 *
 * Pure, so every rule is a unit test rather than a behaviour observed by
 * sending prompts and hoping.
 */

export class SchemaValidationError extends Error {
  constructor(errors) {
    super(`Output did not match the requested schema: ${errors[0]}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

/**
 * Extract JSON from a model's reply.
 *
 * Models fence their JSON in markdown far more often than they should, and a
 * `JSON.parse` that fails on ```` ```json ```` is a validation failure caused by
 * presentation rather than by structure. Unwrapping first means the schema
 * check judges the data, not the decoration.
 */
export function parseModelJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "the model returned nothing" };

  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return { ok: true, value: JSON.parse(unfenced) };
  } catch {
    // A last attempt at the outermost object or array. Models sometimes prepend
    // "Here is the JSON you asked for:" despite being told not to.
    const start = unfenced.search(/[[{]/);
    const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      try {
        return { ok: true, value: JSON.parse(unfenced.slice(start, end + 1)) };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: "the model did not return valid JSON" };
  }
}

/**
 * @param {unknown} value
 * @param {object} schema  JSON Schema subset
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  check(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function check(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  const type = schema.type;
  if (type && !matchesType(value, type)) {
    errors.push(`${path} must be ${Array.isArray(type) ? type.join(" or ") : type}, got ${describe(value)}`);
    // No point checking an object's properties when it is not an object.
    return;
  }

  if (type === "object" || (!type && isPlainObject(value) && schema.properties)) {
    for (const key of schema.required ?? []) {
      if (!isPlainObject(value) || !(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (isPlainObject(value) && key in value) check(value[key], sub, `${path}.${key}`, errors);
    }
    // `additionalProperties: false` is the keyword that makes a schema a
    // contract rather than a suggestion, and it is the one models most often
    // ignore — so it is enforced here even though several providers do not.
    if (schema.additionalProperties === false && isPlainObject(value)) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not an allowed property`);
      }
    }
  }

  if (type === "array" && Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} needs at least ${schema.minItems} items`);
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} allows at most ${schema.maxItems} items`);
    }
    if (schema.items) value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, errors));
  }

  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} is shorter than ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} is longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${path} is below ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${path} is above ${schema.maximum}`);
    }
  }
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "object":
        return isPlainObject(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      // `integer` before `number`: a schema asking for an integer and receiving
      // 1.5 has not been satisfied, and several providers return floats freely.
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const describe = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/** Keywords this validator does not implement, so a caller can be warned. */
export const UNSUPPORTED_KEYWORDS = Object.freeze([
  "$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "patternProperties",
]);

/**
 * A schema using keywords no provider enforces either.
 *
 * Reported rather than rejected: the request still works, and the caller should
 * know the guarantee is weaker than the schema implies.
 */
export function unsupportedKeywords(schema, found = new Set()) {
  if (!schema || typeof schema !== "object") return [...found];
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) found.add(key);
    const child = schema[key];
    if (child && typeof child === "object") {
      Array.isArray(child)
        ? child.forEach((c) => unsupportedKeywords(c, found))
        : unsupportedKeywords(child, found);
    }
  }
  return [...found];
}
