import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { HttpClient } from "../../src/infrastructure/providers/shared/HttpClient.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";
import { StreamEventType } from "../../src/domain/streaming/StreamEvent.js";
import { CancelledError } from "../../src/domain/errors/index.js";

import * as groq from "../../src/infrastructure/providers/adapters/groq/index.js";
import * as deepseek from "../../src/infrastructure/providers/adapters/deepseek/index.js";
import * as qwen from "../../src/infrastructure/providers/adapters/qwen/index.js";
import * as mistral from "../../src/infrastructure/providers/adapters/mistral/index.js";
import * as openrouter from "../../src/infrastructure/providers/adapters/openrouter/index.js";
import * as zhipu from "../../src/infrastructure/providers/adapters/zhipu/index.js";
import * as nvidia from "../../src/infrastructure/providers/adapters/nvidia/index.js";
import * as gemini from "../../src/infrastructure/providers/adapters/gemini/index.js";

/**
 * The transport half of the provider contract — the cases deferred from Phase 2
 * as `TRANSPORT_CASES`, now that real HTTP adapters exist.
 *
 * Intercepts at `fetch` rather than mocking the adapter, so the adapter's real
 * parsing, real error mapping and real streaming run against a controlled
 * response. Mocking the adapter would only prove the mock works.
 *
 * Every one of the eight production providers runs the whole suite: the
 * router's correctness is a *fleet* property, and an adapter that maps `429`
 * differently breaks routing in a way that looks like a router bug.
 */

const DIALECT_ADAPTERS = [
  { name: "groq", module: groq, model: "llama-3.3-70b-versatile" },
  { name: "deepseek", module: deepseek, model: "deepseek-chat" },
  { name: "qwen", module: qwen, model: "qwen-plus" },
  { name: "mistral", module: mistral, model: "mistral-large-latest" },
  { name: "openrouter", module: openrouter, model: "meta-llama/llama-3.3-70b-instruct:free" },
  { name: "zhipu", module: zhipu, model: "glm-4-flash" },
  { name: "nvidia", module: nvidia, model: "meta/llama-3.3-70b-instruct" },
];

const ALL_ADAPTERS = [...DIALECT_ADAPTERS, { name: "gemini", module: gemini, model: "gemini-2.5-flash" }];

/** A fetch stub returning a scripted response. */
function fakeFetch(handler) {
  return async (url, init) => handler({ url: String(url), init });
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const textResponse = (body, status) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

function build({ module, fetchImpl, settings = {} }) {
  const descriptor = new ProviderDescriptor(module.descriptor);
  return new module.Adapter({
    descriptor,
    models: descriptor.models.map((m) => new ModelDescriptor({ ...m, provider: descriptor.id })),
    logger: silentLogger,
    clock: new SystemClock(),
    credential: new Secret("test-key-value", descriptor.envKeys[0]),
    settings,
    http: new HttpClient({ fetch: fetchImpl, clock: new SystemClock() }),
  });
}

/* ------------------------------------------------------------------ *
 * Error mapping — the taxonomy every routing decision is made from.
 * ------------------------------------------------------------------ */

describe("adapter transport — error mapping", () => {
  for (const { name, module, model } of ALL_ADAPTERS) {
    describe(name, () => {
      const call = (fetchImpl) =>
        build({ module, fetchImpl }).generate([{ role: "user", content: "x" }], { model });

      test("429 with a quota body maps to quota", async () => {
        // The distinction the router most depends on: quota means the allowance
        // is gone and waiting will not help.
        await assert.rejects(
          () =>
            call(
              fakeFetch(async () =>
                textResponse('{"error":{"message":"You exceeded your current quota"}}', 429)
              )
            ),
          (error) => {
            assert.equal(error.failureKind, "quota", `${name} must classify quota`);
            return true;
          }
        );
      });

      test("429 without a quota body maps to rate_limit", async () => {
        await assert.rejects(
          () =>
            call(
              fakeFetch(async () => textResponse('{"error":{"message":"Too many requests"}}', 429))
            ),
          (error) => {
            assert.equal(error.failureKind, "rate_limit");
            return true;
          }
        );
      });

      test("Retry-After in the body is parsed", async () => {
        await assert.rejects(
          () =>
            call(
              fakeFetch(async () =>
                textResponse('{"error":{"message":"slow down","retry_after":30}}', 429)
              )
            ),
          (error) => {
            assert.equal(error.retryAfter, 30);
            return true;
          }
        );
      });

      test("401 and 403 map to auth", async () => {
        for (const status of [401, 403]) {
          await assert.rejects(
            () => call(fakeFetch(async () => textResponse('{"error":"bad key"}', status))),
            (error) => {
              assert.equal(error.failureKind, "auth");
              return true;
            }
          );
        }
      });

      test("5xx maps to outage", async () => {
        for (const status of [500, 502, 503]) {
          await assert.rejects(
            () => call(fakeFetch(async () => textResponse("upstream exploded", status))),
            (error) => {
              assert.equal(error.failureKind, "outage");
              return true;
            }
          );
        }
      });

      test("400 maps to api_error, which must NOT fail over", async () => {
        // The request was rejected; a second provider would fail identically.
        await assert.rejects(
          () => call(fakeFetch(async () => textResponse('{"error":"bad model"}', 400))),
          (error) => {
            assert.equal(error.failureKind, "api_error");
            return true;
          }
        );
      });

      test("a connection failure maps to outage", async () => {
        await assert.rejects(
          () =>
            call(
              fakeFetch(async () => {
                throw new TypeError("fetch failed");
              })
            ),
          (error) => {
            assert.equal(error.failureKind, "outage");
            return true;
          }
        );
      });

      test("no error message leaks the credential", async () => {
        await assert.rejects(
          () => call(fakeFetch(async () => textResponse("test-key-value is invalid", 401))),
          (error) => {
            const text = `${error.message} ${JSON.stringify(error.details ?? {})}`;
            assert.ok(!text.includes("test-key-value"), `${name} leaked its key: ${text}`);
            return true;
          }
        );
      });

      test("the credential is sent, but never as a URL parameter", async () => {
        // A key in a URL ends up in access logs, proxy logs, and quoted error
        // messages — the exact leak paths the security model closes.
        let seen = null;
        await call(
          fakeFetch(async (request) => {
            seen = request;
            return jsonResponse(successBody(name, model));
          })
        ).catch(() => {});

        assert.ok(seen, "the adapter must have made a request");
        assert.ok(!seen.url.includes("test-key-value"), "key must not appear in the URL");
        const headers = JSON.stringify(seen.init.headers);
        assert.ok(headers.includes("test-key-value"), "key must be sent as a header");
      });
    });
  }
});

/* ------------------------------------------------------------------ *
 * Streaming — normalisation to the shared event protocol.
 * ------------------------------------------------------------------ */

describe("adapter transport — streaming", () => {
  for (const { name, module, model } of DIALECT_ADAPTERS) {
    test(`${name} normalises SSE frames into StreamEvents`, async () => {
      const adapter = build({
        module,
        fetchImpl: fakeFetch(async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ])
        ),
      });

      const events = [];
      for await (const event of adapter.stream([{ role: "user", content: "hi" }], { model })) {
        events.push(event);
      }

      assert.equal(events[0].type, StreamEventType.START);
      const text = events
        .filter((e) => e.type === StreamEventType.DELTA)
        .map((e) => e.text)
        .join("");
      assert.equal(text, "Hello world");
      assert.equal(events.at(-1).type, StreamEventType.DONE);
      assert.equal(events.at(-1).finishReason, "stop");
    });

    test(`${name} survives a split frame and a malformed frame`, async () => {
      const adapter = build({
        module,
        fetchImpl: fakeFetch(async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"con',
            'tent":"split"}}]}\n\n',
            "data: {not json}\n\n",
            'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
            "data: [DONE]\n\n",
          ])
        ),
      });

      const text = [];
      for await (const event of adapter.stream([{ role: "user", content: "hi" }], { model })) {
        if (event.type === StreamEventType.DELTA) text.push(event.text);
      }
      assert.equal(text.join(""), "split!", "a malformed frame must not kill the stream");
    });

    test(`${name} reports usage when the provider sends it`, async () => {
      const adapter = build({
        module,
        fetchImpl: fakeFetch(async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n',
            "data: [DONE]\n\n",
          ])
        ),
      });

      const events = [];
      for await (const event of adapter.stream([{ role: "user", content: "hi" }], { model })) {
        events.push(event);
      }
      const usage = events.find((e) => e.type === StreamEventType.USAGE);
      assert.ok(usage, "usage is what cost accounting is computed from");
      assert.equal(usage.promptTokens, 11);
    });
  }

  test("gemini normalises its own wire format", async () => {
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async () =>
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Bonjour"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":" monde"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
        ])
      ),
    });

    const events = [];
    for await (const event of adapter.stream([{ role: "user", content: "hi" }], {
      model: "gemini-2.5-flash",
    })) {
      events.push(event);
    }

    const text = events
      .filter((e) => e.type === StreamEventType.DELTA)
      .map((e) => e.text)
      .join("");
    assert.equal(text, "Bonjour monde");
    assert.equal(events.at(-1).type, StreamEventType.DONE);
    assert.ok(events.some((e) => e.type === StreamEventType.USAGE));
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation and empty responses.
 * ------------------------------------------------------------------ */

describe("adapter transport — cancellation and empty responses", () => {
  test("an aborted signal surfaces as CancelledError, not a provider failure", async () => {
    // Recording it as a failure would open a breaker on a healthy provider.
    const controller = new AbortController();
    controller.abort();

    const adapter = build({
      module: groq,
      fetchImpl: fakeFetch(async () => jsonResponse(successBody("groq", "x"))),
    });

    await assert.rejects(
      () =>
        adapter.generate([{ role: "user", content: "x" }], {
          model: "llama-3.3-70b-versatile",
          signal: controller.signal,
        }),
      (error) => CancelledError.is(error)
    );
  });

  test("an empty completion is an outage, never a blank success", async () => {
    // Silent quota exhaustion often manifests this way; returning it would show
    // the user a blank reply while the router counted a win.
    const adapter = build({
      module: groq,
      fetchImpl: fakeFetch(async () =>
        jsonResponse({ choices: [{ message: { content: "" } }] })
      ),
    });

    await assert.rejects(
      () => adapter.generate([{ role: "user", content: "x" }], { model: "llama-3.3-70b-versatile" }),
      (error) => {
        assert.equal(error.failureKind, "outage");
        return true;
      }
    );
  });

  test("gemini treats a safety block as api_error, so it is not retried elsewhere", async () => {
    // The request was refused; another provider would refuse it identically.
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async () =>
        jsonResponse({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] })
      ),
    });

    await assert.rejects(
      () => adapter.generate([{ role: "user", content: "x" }], { model: "gemini-2.5-flash" }),
      (error) => {
        assert.equal(error.failureKind, "api_error");
        assert.match(error.message, /declined/);
        return true;
      }
    );
  });

  test("gemini maps RESOURCE_EXHAUSTED to quota, not rate_limit", async () => {
    // The shared mapper would read it as a rate limit — a 60s cooldown instead
    // of the 15 minutes a quota needs.
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async () =>
        textResponse('{"error":{"status":"RESOURCE_EXHAUSTED"}}', 429)
      ),
    });

    await assert.rejects(
      () => adapter.generate([{ role: "user", content: "x" }], { model: "gemini-2.5-flash" }),
      (error) => {
        assert.equal(error.failureKind, "quota");
        return true;
      }
    );
  });

  test("gemini maps a rejected key to auth, even though it arrives as a 400", async () => {
    // **Found by live verification.** Gemini rejects an invalid or revoked key
    // with `400 INVALID_ARGUMENT`, not the 401/403 every other provider uses,
    // and the shared mapper reads 400 as `api_error` — the one kind that is
    // deliberately never retried and never failed over.
    //
    // The consequence was severe and silent: a rotated Gemini key meant every
    // request failed outright with no failover, the breaker never opened, and
    // the `auth`-keyed "platform key rejected" alert never fired. This suite
    // was green throughout, because it only ever sent 401/403 as auth failures.
    //
    // The body below is the real one, captured from the live API.
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async () =>
        textResponse(
          JSON.stringify({
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
              details: [{ reason: "API_KEY_INVALID" }],
            },
          }),
          400
        )
      ),
    });

    await assert.rejects(
      () => adapter.generate([{ role: "user", content: "x" }], { model: "gemini-2.5-flash" }),
      (error) => {
        assert.equal(error.failureKind, "auth", "a dead key must open the breaker immediately");
        return true;
      }
    );
  });

  test("gemini's thinking budget is added to the output cap, not taken from it", async () => {
    // **Found by live verification.** Gemini 2.5 charges thinking tokens
    // against `maxOutputTokens`: a request for 16 came back with 11 thinking
    // tokens, 1 visible token, and finishReason MAX_TOKENS. `maxTokens` is
    // normalised here to mean *visible* output.
    let sent = null;
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async ({ init }) => {
        sent = JSON.parse(init.body);
        return textResponse(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 40, totalTokenCount: 47 },
          }),
          200
        );
      }),
      settings: { thinkingBudget: 128 },
    });

    const result = await adapter.generate([{ role: "user", content: "x" }], {
      model: "gemini-2.5-flash",
      maxTokens: 500,
    });

    assert.equal(sent.generationConfig.maxOutputTokens, 628, "the budget must be added, not shared");
    assert.equal(sent.generationConfig.thinkingConfig.thinkingBudget, 128);

    // Thinking tokens are generated and billed but reported separately, so
    // reading `candidatesTokenCount` alone under-reports spend — here by 20x.
    assert.equal(result.usage.completionTokens, 42);
    assert.equal(result.usage.thinkingTokens, 40);
  });

  test("the combined budget never exceeds the model's real ceiling", async () => {
    // Asking a model for more output than it accepts is an error, not a
    // longer answer.
    let sent = null;
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async ({ init }) => {
        sent = JSON.parse(init.body);
        return textResponse(
          '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}',
          200
        );
      }),
      settings: { thinkingBudget: 4096 },
    });

    await adapter.generate([{ role: "user", content: "x" }], {
      model: "gemini-2.5-flash",
      maxTokens: 8000,
    });

    assert.equal(sent.generationConfig.maxOutputTokens, 8192, "clamped to the declared ceiling");
  });

  test("a safety block is still api_error, not auth", async () => {
    // The matcher keys on API-key phrasing rather than on the 400 status, so a
    // genuinely malformed request must not be misread as a credential problem —
    // that would open the breaker on a healthy provider.
    const adapter = build({
      module: gemini,
      fetchImpl: fakeFetch(async () =>
        textResponse('{"error":{"code":400,"message":"Invalid JSON payload"}}', 400)
      ),
    });

    await assert.rejects(
      () => adapter.generate([{ role: "user", content: "x" }], { model: "gemini-2.5-flash" }),
      (error) => {
        assert.equal(error.failureKind, "api_error");
        return true;
      }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Capability honesty across the fleet.
 * ------------------------------------------------------------------ */

describe("adapter transport — capability declarations", () => {
  for (const { name, module } of ALL_ADAPTERS) {
    test(`${name} declares only capabilities it can serve`, () => {
      const descriptor = new ProviderDescriptor(module.descriptor);
      assert.ok(descriptor.models.length > 0, "a provider with no models can never be routed to");

      for (const raw of descriptor.models) {
        const model = new ModelDescriptor({ ...raw, provider: descriptor.id });
        // Every routable model must declare a window and an output cap, or
        // budgeting silently divides by an assumption.
        assert.ok(
          model.contextWindow > 0 || model.supports("embeddings"),
          `${raw.id} must declare a context window`
        );
        assert.ok(model.maxOutputTokens > 0, `${raw.id} must declare maxOutputTokens`);
        // structuredOutput implies json — a schema-enforcing model necessarily
        // produces parseable output.
        if (model.supports("structuredOutput")) {
          assert.ok(model.supports("json"), `${raw.id}: structuredOutput implies json`);
        }
      }
    });

    test(`${name} declares its credential variables`, () => {
      const descriptor = new ProviderDescriptor(module.descriptor);
      assert.ok(descriptor.envKeys.length > 0, "otherwise it can never be configured");
      assert.equal(descriptor.requiresCredentials, true);
    });
  }
});

/** A minimal success body in whichever dialect the adapter expects. */
function successBody(name, model) {
  if (name === "gemini") {
    return { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
  }
  return { model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
}
