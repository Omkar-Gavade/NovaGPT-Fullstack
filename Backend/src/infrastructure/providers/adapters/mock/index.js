import { BaseProvider } from "../../shared/BaseProvider.js";
import { ProviderError, FailureKind } from "../../../../domain/errors/ProviderError.js";
import {
  startEvent,
  deltaEvent,
  usageEvent,
  doneEvent,
} from "../../../../domain/streaming/StreamEvent.js";

/**
 * The mock provider.
 *
 * Two jobs, and it is the only adapter in this phase:
 *
 *   1. **Reference implementation.** It is what the contract suite runs
 *      against, so the suite is proven to be satisfiable before any real
 *      adapter is written. A contract nothing has ever passed is a guess.
 *   2. **Scriptable failure.** Every failure kind, timeout, and cancellation
 *      path can be produced on demand, which is what makes the router's retry,
 *      failover, and breaker behaviour testable in Phase 3 without touching a
 *      network.
 *
 * Makes **no network calls** — deliberate, and the reason it is safe to ship: a
 * provider that cannot reach the internet cannot leak a prompt or spend a quota
 * unit. It is disabled unless `MOCK_PROVIDER_ENABLED` is set, so it never
 * appears in a production fleet by accident.
 *
 * ## Scripting
 *
 * ```js
 * provider.script([
 *   { fail: "quota" },        // attempt 1
 *   { fail: "timeout" },      // attempt 2
 *   { text: "final answer" }, // attempt 3
 * ]);
 * ```
 */

export const descriptor = {
  id: "mock",
  name: "Mock Provider",
  dialect: "mock",
  adapterVersion: "1.0.0",
  // Not a real credential. It exists so the mock follows the same
  // configured/unconfigured path as every other adapter rather than being a
  // special case the factory has to know about.
  envKeys: ["MOCK_PROVIDER_ENABLED"],
  requiresCredentials: true,
  experimental: true,
  models: [
    {
      id: "mock-standard",
      displayName: "Mock Standard",
      capabilities: {
        streaming: true,
        json: true,
        toolCalling: true,
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        reasoning: 70,
        coding: 70,
        multilingual: 70,
        speed: 100,
      },
      tier: "free",
      costBand: "Free",
    },
    {
      // A second model with different capabilities, so capability-aware tests
      // have something to discriminate between. A single-model provider cannot
      // exercise "route to the model that supports vision".
      id: "mock-vision",
      displayName: "Mock Vision",
      capabilities: {
        streaming: true,
        vision: true,
        json: true,
        structuredOutput: true,
        embeddings: true,
        contextWindow: 32_000,
        maxOutputTokens: 2048,
        reasoning: 60,
        speed: 80,
      },
      tier: "free",
      costBand: "Free",
    },
  ],
};

export class Adapter extends BaseProvider {
  constructor(config) {
    super(config);
    /** @type {Array<object>} */
    this.plan = [];
    this.attempt = 0;
    this.calls = [];
    this.defaultText = config?.settings?.defaultText ?? "mock response";
    this.latencyMs = config?.settings?.latencyMs ?? 0;
  }

  /* ------------------------------- scripting ----------------------------- */

  /** Queue per-attempt behaviour. Resets the attempt counter. */
  script(steps = []) {
    this.plan = [...steps];
    this.attempt = 0;
    return this;
  }

  reset() {
    this.plan = [];
    this.attempt = 0;
    this.calls = [];
    return this;
  }

  /** @private */
  next(method, options) {
    this.calls.push({ method, model: options?.model, at: this.clock?.now?.() ?? Date.now() });
    // Past the end of the script, behaviour is steady rather than undefined —
    // a test asserting "and then it keeps working" should not have to script
    // an unbounded number of successes.
    const step = this.plan[this.attempt] ?? {};
    this.attempt += 1;
    return step;
  }

  /** @private */
  async applyStep(step, options) {
    if (step.delayMs) await this.sleep(step.delayMs, options?.signal);
    else if (this.latencyMs) await this.sleep(this.latencyMs, options?.signal);

    if (options?.signal?.aborted) throw abortError();

    if (step.fail) {
      throw new ProviderError(
        step.message ?? `mock ${step.fail}`,
        FailureKind[step.fail.toUpperCase()] ?? step.fail,
        { provider: this.id, retryAfter: step.retryAfter, upstreamStatus: step.status }
      );
    }
  }

  /** @private — abortable so cancellation tests are not timing races. */
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true }
      );
    });
  }

  /* ---------------------------- capability methods ----------------------- */

  async generate(messages, options = {}) {
    this.assertSupported("generate", options.model);
    const step = this.next("generate", options);
    await this.applyStep(step, options);

    const text = step.text ?? this.defaultText;
    return {
      text,
      usage: { promptTokens: estimate(messages), completionTokens: estimate([{ content: text }]) },
      model: options.model,
      finishReason: step.finishReason ?? "stop",
    };
  }

  async *stream(messages, options = {}) {
    this.assertSupported("stream", options.model);
    const step = this.next("stream", options);
    await this.applyStep(step, options);

    yield startEvent(options.model, this.id);

    // An empty stream is scriptable because it is a real provider behaviour —
    // silent quota exhaustion often manifests as an empty 200 — and the router
    // must treat it as a failure rather than a blank success
    // (docs/backend/07-streaming-engine.md).
    const text = step.emptyStream ? "" : step.text ?? this.defaultText;
    let emitted = 0;
    for (const chunk of chunks(text)) {
      if (options.signal?.aborted) throw abortError();
      yield deltaEvent(chunk);
      emitted += 1;
      // Fails *after* deltas have reached the caller — the case that makes
      // mid-stream failover hard, because the client has already rendered
      // output that a second provider will not continue.
      if (step.failAfterChunks !== undefined && emitted >= step.failAfterChunks) {
        throw new ProviderError("mock mid-stream failure", step.failMidStreamKind ?? FailureKind.OUTAGE, {
          provider: this.id,
        });
      }
    }

    yield usageEvent({ promptTokens: estimate(messages), completionTokens: estimate([{ content: text }]) });
    yield doneEvent(options.model, this.id, step.finishReason ?? "stop");
  }

  async vision(images, prompt, options = {}) {
    this.assertSupported("vision", options.model);
    const step = this.next("vision", options);
    await this.applyStep(step, options);
    return {
      text: step.text ?? `mock vision response for ${images.length} image(s)`,
      usage: null,
      model: options.model,
    };
  }

  async embeddings(inputs, options = {}) {
    this.assertSupported("embeddings", options.model);
    const step = this.next("embeddings", options);
    await this.applyStep(step, options);
    // Deterministic from the input, so a test can assert that the same text
    // produces the same vector without pinning a literal.
    return inputs.map((text) => deterministicVector(text, step.dimensions ?? 8));
  }

  async toolCalling(messages, tools, options = {}) {
    this.assertSupported("toolCalling", options.model);
    const step = this.next("toolCalling", options);
    await this.applyStep(step, options);
    return {
      text: step.text ?? "",
      toolCalls: step.toolCalls ?? [
        { id: "call_1", name: tools[0]?.name ?? "unknown", arguments: {} },
      ],
      model: options.model,
    };
  }

  async health(options = {}) {
    const step = this.plan[this.attempt];
    if (step?.unhealthy) {
      return { ok: false, latencyMs: 0, error: step.message ?? "mock unhealthy" };
    }
    // A scripted `auth` failure means the credential is rejected, and a real
    // provider's probe endpoint rejects a bad key exactly as its completion
    // endpoint does. Without this the mock would accept a credential it is
    // about to refuse — which would make BYOK validation untestable.
    if (step?.fail === "auth") {
      return { ok: false, latencyMs: 0, error: "mock auth" };
    }
    return super.health(options);
  }
}

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Split into word-ish chunks so a stream has more than one delta. */
function chunks(text) {
  if (!text) return [];
  return text.match(/\S+\s*/g) ?? [text];
}

const estimate = (messages) =>
  Math.ceil(messages.reduce((sum, m) => sum + String(m?.content ?? "").length, 0) / 4);

function deterministicVector(text, dimensions) {
  const vector = [];
  for (let i = 0; i < dimensions; i += 1) {
    let hash = i + 1;
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
    vector.push(hash / 1000);
  }
  return vector;
}
