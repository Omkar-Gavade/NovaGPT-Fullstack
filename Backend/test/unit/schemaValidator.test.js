import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelJson,
  validateAgainstSchema,
  unsupportedKeywords,
} from "../../src/domain/capability/SchemaValidator.js";

/**
 * Server-side validation of structured output.
 *
 * Providers advertise schema enforcement and do not always deliver it. A client
 * that asked for `json_schema` and got a paragraph cannot tell that apart from
 * a bug of its own — which is why the acceptance criterion is that the server
 * checks before the client sees it.
 */

describe("parsing a model's JSON", () => {
  test("parses plain JSON", () => {
    assert.deepEqual(parseModelJson('{"a":1}').value, { a: 1 });
  });

  test("unwraps a fenced code block", () => {
    // Models fence their JSON far more often than they should, and a parse that
    // fails on ```json is a validation failure caused by presentation.
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```').value, { a: 1 });
    assert.deepEqual(parseModelJson('```\n{"a":1}\n```').value, { a: 1 });
  });

  test("recovers JSON preceded by an apology", () => {
    const reply = 'Sure! Here is the JSON you asked for:\n{"a": 1, "b": [2]}';
    assert.deepEqual(parseModelJson(reply).value, { a: 1, b: [2] });
  });

  test("reports prose as a failure rather than guessing", () => {
    assert.equal(parseModelJson("I cannot help with that.").ok, false);
    assert.equal(parseModelJson("").ok, false);
  });
});

describe("schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "integer", minimum: 0 },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      status: { enum: ["active", "archived"] },
    },
    required: ["name", "age"],
    additionalProperties: false,
  };

  const check = (value) => validateAgainstSchema(value, schema);

  test("accepts a conforming object", () => {
    assert.equal(check({ name: "a", age: 3, tags: ["x"], status: "active" }).valid, true);
  });

  test("names the missing required field", () => {
    // An error saying only "invalid" gives a client nothing to act on.
    const result = check({ name: "a" });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /\$\.age is required/);
  });

  test("rejects a float where an integer was asked for", () => {
    // Several providers return floats freely, and a schema asking for an
    // integer has not been satisfied by 1.5.
    assert.equal(check({ name: "a", age: 1.5 }).valid, false);
  });

  test("enforces additionalProperties: false", () => {
    // The keyword that makes a schema a contract rather than a suggestion, and
    // the one models most often ignore.
    const result = check({ name: "a", age: 1, extra: true });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /extra is not an allowed property/);
  });

  test("enforces enums, bounds and array limits", () => {
    assert.equal(check({ name: "a", age: 1, status: "deleted" }).valid, false);
    assert.equal(check({ name: "a", age: -1 }).valid, false);
    assert.equal(check({ name: "", age: 1 }).valid, false);
    assert.equal(check({ name: "a", age: 1, tags: ["a", "b", "c", "d"] }).valid, false);
  });

  test("validates nested structures by path", () => {
    const nested = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } },
    };
    const result = validateAgainstSchema({ items: [{ id: 1 }, { id: "two" }] }, nested);

    assert.equal(result.valid, false);
    // The path is what makes a nested failure actionable.
    assert.match(result.errors[0], /\$\.items\[1\]\.id must be integer/);
  });

  test("distinguishes null from absent", () => {
    assert.equal(validateAgainstSchema(null, { type: "object" }).valid, false);
    assert.equal(validateAgainstSchema(null, { type: "null" }).valid, true);
  });

  test("reports every problem, not just the first", () => {
    // Fixing one field per round trip is a miserable loop for a client that
    // generated the request programmatically.
    const result = check({ age: "old", extra: 1 });
    assert.ok(result.errors.length >= 2, JSON.stringify(result.errors));
  });
});

describe("unsupported keywords", () => {
  test("names keywords the validator does not implement", () => {
    // Reported rather than rejected: a schema using them is one no provider
    // enforces either, so the caller should know the guarantee is weaker than
    // their schema implies.
    const found = unsupportedKeywords({
      type: "object",
      properties: { a: { oneOf: [{ type: "string" }] } },
    });
    assert.deepEqual(found, ["oneOf"]);
  });

  test("says nothing about a schema it fully supports", () => {
    assert.deepEqual(unsupportedKeywords({ type: "object", properties: { a: { type: "string" } } }), []);
  });
});
