import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as gemini from "../../src/infrastructure/providers/adapters/gemini/index.js";
import * as groq from "../../src/infrastructure/providers/adapters/groq/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { HttpClient } from "../../src/infrastructure/providers/shared/HttpClient.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";
import { ToolCall } from "../../src/domain/capability/ToolCall.js";

/**
 * The acceptance criterion, as a test:
 *
 * > Tool-call responses are normalised identically across every tool-capable
 * > provider.
 *
 * The two dialects disagree on the field that matters most. The OpenAI dialect
 * returns `arguments` as a **JSON string**; Gemini returns `args` as an
 * already-parsed **object**. A client handed one shape and then the other after
 * a failover has to sniff the type on every call — which makes the failover
 * visible, which is the thing the abstraction exists to prevent.
 */

const fakeFetch = (handler) => async (url, init) => handler({ url: String(url), init });

const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

function build(module, fetchImpl) {
  const descriptor = new ProviderDescriptor(module.descriptor);
  return new module.Adapter({
    descriptor,
    models: descriptor.models.map((m) => new ModelDescriptor({ ...m, provider: descriptor.id })),
    logger: silentLogger,
    clock: new SystemClock(),
    credential: new Secret("test-key", descriptor.envKeys[0]),
    settings: {},
    http: new HttpClient({ fetch: fetchImpl, clock: new SystemClock() }),
  });
}

const TOOLS = [
  {
    name: "get_weather",
    description: "Current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];

describe("tool calling — identical across dialects", () => {
  test("the OpenAI dialect's JSON-string arguments become an object", async () => {
    const adapter = build(groq, fakeFetch(async () =>
      textResponse(
        JSON.stringify({
          model: "llama-3.3-70b-versatile",
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_abc",
                    function: { name: "get_weather", arguments: '{"city":"Pune"}' },
                  },
                ],
              },
            },
          ],
        })
      )
    ));

    const result = await adapter.toolCalling([{ role: "user", content: "weather?" }], TOOLS, {
      model: "llama-3.3-70b-versatile",
    });

    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(result.toolCalls[0].arguments, { city: "Pune" });
    assert.equal(result.toolCalls[0].name, "get_weather");
    assert.equal(result.toolCalls[0].id, "call_abc");
    // The raw form is kept so a client echoing the call back is byte-identical.
    assert.equal(result.toolCalls[0].raw, '{"city":"Pune"}');
  });

  test("Gemini's already-parsed arguments come back in the same shape", async () => {
    // **Gemini declared `toolCalling: true` and never implemented the method.**
    // Routing would select it — capability matching passes — and the call threw
    // `unsupported` at dispatch, which the router deliberately does not fail
    // over on, because an unsupported capability means the matrix is wrong.
    const adapter = build(gemini, fakeFetch(async () =>
      textResponse(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "get_weather", args: { city: "Pune" } } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        })
      )
    ));

    const result = await adapter.toolCalling([{ role: "user", content: "weather?" }], TOOLS, {
      model: "gemini-2.5-flash",
    });

    assert.deepEqual(result.toolCalls[0].arguments, { city: "Pune" });
    assert.equal(result.toolCalls[0].name, "get_weather");
    // Gemini issues no call id, so one is synthesised — its absence would
    // otherwise be a per-provider difference a client has to handle.
    assert.ok(result.toolCalls[0].id, "a call needs an id a result can be correlated to");
  });

  test("both dialects produce the same keys, in the same types", async () => {
    // The criterion stated precisely: a client must not be able to tell which
    // provider answered from the shape of the response.
    const fromOpenAI = ToolCall.fromOpenAI({
      id: "call_1",
      function: { name: "f", arguments: '{"a":1}' },
    }).toJSON();
    const fromGemini = ToolCall.fromGemini({ name: "f", args: { a: 1 } }, 0).toJSON();

    assert.deepEqual(Object.keys(fromOpenAI).sort(), Object.keys(fromGemini).sort());
    assert.deepEqual(fromOpenAI.arguments, fromGemini.arguments);
    assert.equal(typeof fromOpenAI.arguments, typeof fromGemini.arguments);
    assert.equal(typeof fromOpenAI.id, typeof fromGemini.id);
  });

  test("invalid JSON in the arguments yields empty arguments, not a throw", async () => {
    // Models emit malformed JSON in that string often enough to matter, and the
    // *call* is still information even when its payload is not.
    const call = ToolCall.fromOpenAI({
      id: "call_2",
      function: { name: "f", arguments: "{not json" },
    });

    assert.deepEqual(call.arguments, {});
    assert.equal(call.raw, "{not json");
    assert.equal(call.name, "f");
  });

  test("a reply with no tool call returns an empty list, not null", async () => {
    // A caller iterating the result must not have to null-check first.
    const adapter = build(groq, fakeFetch(async () =>
      textResponse(JSON.stringify({ choices: [{ message: { content: "I don't need a tool." } }] }))
    ));

    const result = await adapter.toolCalling([{ role: "user", content: "hi" }], TOOLS, {
      model: "llama-3.3-70b-versatile",
    });

    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.text, "I don't need a tool.");
  });
});

describe("tool calling — the execution boundary", () => {
  test("no adapter exposes a way to execute a tool", () => {
    // Tool *execution* is deliberately out of scope: it is a trust and
    // sandboxing problem of a different kind. This is the test that notices if
    // someone adds it quietly (docs/backend/14-roadmap.md).
    for (const module of [gemini, groq]) {
      const proto = module.Adapter.prototype;
      const names = Object.getOwnPropertyNames(proto);
      const executors = names.filter((n) => /execute|invokeTool|runTool|callTool/i.test(n));
      assert.deepEqual(executors, [], `${module.descriptor.id} exposes tool execution`);
    }
  });
});
