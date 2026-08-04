import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, UnsupportedCapabilityError } from "../../src/domain/errors/ProviderError.js";
import { AppError } from "../../src/domain/errors/AppError.js";
import { CapabilitySet } from "../../src/domain/capability/CapabilitySet.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { PROVIDER_INTERFACE, METHOD_CAPABILITY } from "../../src/domain/ports/ProviderPort.js";
import { StreamEventType, isTerminal } from "../../src/domain/streaming/StreamEvent.js";

/**
 * The shared provider contract suite.
 *
 * **The single most valuable test asset in the system.** One suite, run against
 * every adapter, asserting the guarantees the router depends on.
 *
 * It is shared rather than per-adapter for a specific reason: the router's
 * correctness is a *fleet* property. It depends on every adapter mapping errors
 * into the same taxonomy, cancelling within the same budget, and refusing the
 * same unsupported capabilities. Per-adapter tests drift — the eighth adapter
 * gets written by someone who tested slightly different things, and the one
 * guarantee they skipped is the one the router relies on. A shared suite means
 * a new adapter cannot merge until it behaves like all the others
 * (docs/backend/15-decisions.md#adr-020--a-shared-contract-test-suite-for-every-adapter).
 *
 * ## Scope in this phase
 *
 * Phase 2 builds the framework, not the integrations. The cases here are the
 * ones that hold for *any* adapter regardless of transport: interface
 * conformance, capability honesty, error typing, cancellation, and stream
 * shape. The transport-specific cases from
 * docs/backend/12-testing.md#what-every-adapter-must-prove — HTTP status
 * mapping, SSE frame splitting, `[DONE]` terminators — attach in Phase 3 with
 * the first real adapter, and are listed in `TRANSPORT_CASES` below so the gap
 * is recorded rather than forgotten.
 *
 * @param {object} options
 * @param {string} options.name         adapter name, for test output
 * @param {() => Promise<object>|object} options.create  fresh provider per test
 * @param {string} options.model        a model id the provider serves
 * @param {(p: object, kind: string) => void} [options.scriptFailure]
 *        make the next call fail with this FailureKind; omit to skip those cases
 * @param {(p: object, ms: number) => void} [options.scriptDelay]
 *        make the next call take this long; omit to skip cancellation cases
 */
export function runProviderContract({ name, create, model, scriptFailure, scriptDelay }) {
  const build = async () => create();

  describe(`provider contract — ${name}`, () => {
    /* ------------------------- interface conformance ---------------------- */

    test("implements the full provider interface", async () => {
      const provider = await build();
      for (const method of PROVIDER_INTERFACE) {
        assert.equal(
          typeof provider[method],
          "function",
          `missing ${method}() — the router calls this on every adapter`
        );
      }
    });

    test("exposes a stable identity", async () => {
      const provider = await build();
      assert.equal(typeof provider.id, "string");
      assert.ok(provider.id.length > 0);
      assert.equal(typeof provider.name, "string");
      assert.equal(typeof provider.isConfigured, "boolean");
    });

    test("reports capabilities as a validated CapabilitySet", async () => {
      const provider = await build();
      const capabilities = provider.capabilities();
      assert.ok(
        capabilities instanceof CapabilitySet,
        "capabilities() must return a CapabilitySet, so unknown axes cannot be claimed"
      );
    });

    test("lists validated model descriptors", async () => {
      const provider = await build();
      const models = await provider.listModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.length > 0, "a provider with no models can never be routed to");
      for (const entry of models) {
        assert.ok(entry instanceof ModelDescriptor, `${entry?.id} must be a ModelDescriptor`);
        assert.equal(entry.provider, provider.id, "a model must belong to its provider");
      }
    });

    test("provider capabilities are the union of its models'", async () => {
      const provider = await build();
      const models = await provider.listModels();
      const union = new Set(models.flatMap((m) => m.capabilities.supported()));
      for (const capability of provider.capabilities().supported()) {
        assert.ok(
          union.has(capability),
          `provider claims "${capability}" that no model declares — it would be routed and fail`
        );
      }
    });

    /* --------------------------- health ---------------------------------- */

    test("health() reports a shaped result rather than throwing", async () => {
      const provider = await build();
      const result = await provider.health();
      assert.equal(typeof result.ok, "boolean");
      assert.ok(result.latencyMs === null || Number.isFinite(result.latencyMs));
    });

    /* ------------------------- capability honesty ------------------------- */

    test("throws UnsupportedCapabilityError, never returns empty, for what it cannot do", async () => {
      const provider = await build();
      const models = await provider.listModels();

      for (const [method, capability] of Object.entries(METHOD_CAPABILITY)) {
        const incapable = models.find((m) => !m.supports(capability));
        if (!incapable) continue;

        const invoke = () => callMethod(provider, method, { model: incapable.id });
        await assert.rejects(
          invoke,
          (error) => {
            assert.ok(
              error instanceof UnsupportedCapabilityError,
              // An empty return is indistinguishable from a model that had
              // nothing to say, so the router would count it as success and
              // failover would never engage.
              `${method}() on a model without "${capability}" must throw UnsupportedCapabilityError, got ${error?.name}`
            );
            return true;
          },
          `${method}() must refuse a model lacking "${capability}"`
        );
      }
    });

    test("rejects an unknown model id rather than forwarding it upstream", async () => {
      const provider = await build();
      await assert.rejects(
        () => provider.generate([{ role: "user", content: "hi" }], { model: "no-such-model" }),
        (error) => error instanceof AppError,
        "an unknown model must fail as a typed error, not an opaque upstream 404"
      );
    });

    /* ------------------------------ generate ------------------------------ */

    test("generate() returns the documented result shape", async () => {
      const provider = await build();
      const result = await provider.generate([{ role: "user", content: "hello" }], { model });
      assert.equal(typeof result.text, "string");
      assert.ok("usage" in result, "usage must be present, even as null");
      assert.equal(typeof result.model, "string");
    });

    /* ------------------------------- stream ------------------------------- */

    test("stream() yields normalised events ending in exactly one terminal", async () => {
      const provider = await build();
      const events = [];
      for await (const event of provider.stream([{ role: "user", content: "hi" }], { model })) {
        events.push(event);
      }

      assert.ok(events.length > 0, "a stream must yield something");
      for (const event of events) {
        assert.ok(
          Object.values(StreamEventType).includes(event.type),
          `unknown stream event type "${event.type}" — adapters must normalise, not pass through`
        );
      }

      const terminals = events.filter(isTerminal);
      assert.equal(
        terminals.length,
        1,
        "exactly one terminal event: neither leaves the client with a spinner it cannot resolve"
      );
      assert.ok(isTerminal(events.at(-1)), "the terminal event must be last");
      assert.equal(events[0].type, StreamEventType.START, "a stream must announce itself first");
    });

    test("stream() emits at least one delta for non-empty output", async () => {
      const provider = await build();
      const events = [];
      for await (const event of provider.stream([{ role: "user", content: "hi" }], { model })) {
        events.push(event);
      }
      assert.ok(events.some((e) => e.type === StreamEventType.DELTA));
    });

    /* ------------------------- error normalisation ------------------------ */

    if (scriptFailure) {
      const kinds = ["quota", "rate_limit", "timeout", "outage", "auth", "api_error"];

      for (const kind of kinds) {
        test(`maps a ${kind} failure to ProviderError{${kind}}`, async () => {
          const provider = await build();
          scriptFailure(provider, kind);
          await assert.rejects(
            () => provider.generate([{ role: "user", content: "x" }], { model }),
            (error) => {
              assert.ok(
                ProviderError.is(error),
                `a ${kind} failure must surface as ProviderError, got ${error?.name} — ` +
                  "the router makes every retry and failover decision from this taxonomy"
              );
              assert.equal(error.failureKind, kind);
              return true;
            }
          );
        });
      }

      test("no error message leaks a credential", async () => {
        const provider = await build();
        scriptFailure(provider, "auth");
        await assert.rejects(
          () => provider.generate([{ role: "user", content: "x" }], { model }),
          (error) => {
            const text = `${error.message} ${JSON.stringify(error.details ?? {})}`;
            for (const pattern of [/sk-[A-Za-z0-9]{8,}/, /AIza[A-Za-z0-9]{8,}/, /Bearer\s+\S{12,}/]) {
              assert.ok(!pattern.test(text), `error text matched ${pattern}`);
            }
            return true;
          }
        );
      });

      test("every thrown error is an AppError, so no raw SDK error escapes", async () => {
        const provider = await build();
        scriptFailure(provider, "outage");
        await assert.rejects(
          () => provider.generate([{ role: "user", content: "x" }], { model }),
          (error) => AppError.is(error)
        );
      });
    }

    /* --------------------------- routability ------------------------------ */

    /**
     * The router makes every retry and failover decision from `failureKind`
     * alone, and it reads that field off whatever the invoker hands back. These
     * cases assert the adapter holds up its end of that contract *through* the
     * invoker, which is the path the router actually uses — an adapter can pass
     * every error-mapping case above and still break routing if its failures do
     * not survive the invoker boundary.
     */
    if (scriptFailure) {
      test("failures reach the router carrying a failureKind", async () => {
        const { ProviderInvoker } = await import(
          "../../src/infrastructure/routing/ProviderInvoker.js"
        );
        const { SystemClock } = await import("../../src/infrastructure/system/SystemClock.js");

        const provider = await build();
        scriptFailure(provider, "quota");

        const outcome = await new ProviderInvoker({ clock: new SystemClock() }).run({
          provider,
          model: { id: model, provider: provider.id },
          invoke: (p, m, options) => p.generate([{ role: "user", content: "x" }], options),
        });

        assert.equal(outcome.ok, false);
        assert.equal(
          outcome.error.failureKind,
          "quota",
          "the router branches on failureKind; without it every failure looks the same"
        );
        assert.ok(Number.isFinite(outcome.latencyMs), "latency feeds ranking and must be measured");
      });

      test("a success reports the latency that feeds ranking", async () => {
        const { ProviderInvoker } = await import(
          "../../src/infrastructure/routing/ProviderInvoker.js"
        );
        const { SystemClock } = await import("../../src/infrastructure/system/SystemClock.js");

        const provider = await build();
        const outcome = await new ProviderInvoker({ clock: new SystemClock() }).run({
          provider,
          model: { id: model, provider: provider.id },
          invoke: (p, m, options) => p.generate([{ role: "user", content: "x" }], options),
        });

        assert.equal(outcome.ok, true);
        assert.ok(Number.isFinite(outcome.latencyMs));
      });
    }

    if (scriptDelay) {
      test("the invoker's deadline maps to a timeout the router can fail over on", async () => {
        const { ProviderInvoker } = await import(
          "../../src/infrastructure/routing/ProviderInvoker.js"
        );
        const { SystemClock } = await import("../../src/infrastructure/system/SystemClock.js");

        const provider = await build();
        scriptDelay(provider, 5000);

        const outcome = await new ProviderInvoker({
          clock: new SystemClock(),
          attemptTimeoutMs: 30,
        }).run({
          provider,
          model: { id: model, provider: provider.id },
          invoke: (p, m, options) => p.generate([{ role: "user", content: "x" }], options),
        });

        assert.equal(outcome.ok, false);
        // Distinct from cancellation: a deadline is the provider being slow and
        // is worth failing over; a cancellation is not worth anything.
        assert.equal(outcome.error.failureKind, "timeout");
      });
    }

    /* ------------------------------ cancellation -------------------------- */

    if (scriptDelay) {
      test("generate() aborts promptly when the signal fires", async () => {
        const provider = await build();
        scriptDelay(provider, 5000);
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 10);

        await assert.rejects(
          () =>
            provider.generate([{ role: "user", content: "x" }], {
              model,
              signal: controller.signal,
            }),
          (error) => error.name === "AbortError"
        );
        // Stopping local iteration while the provider keeps generating burns
        // the full quota unit for output nobody will read.
        assert.ok(Date.now() - started < 500, "cancellation must not wait out the call");
      });

      test("stream() stops promptly when the signal fires", async () => {
        const provider = await build();
        scriptDelay(provider, 5000);
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 10);

        await assert.rejects(async () => {
          // eslint-disable-next-line no-unused-vars
          for await (const _event of provider.stream([{ role: "user", content: "x" }], {
            model,
            signal: controller.signal,
          })) {
            /* drain */
          }
        }, (error) => error.name === "AbortError");
        assert.ok(Date.now() - started < 500);
      });
    }
  });
}

/** Invoke a capability method with the argument shape it expects. */
function callMethod(provider, method, options) {
  switch (method) {
    case "vision":
      return provider.vision([{ url: "https://example.test/a.png" }], "describe", options);
    case "embeddings":
      return provider.embeddings(["text"], options);
    case "toolCalling":
      return provider.toolCalling([{ role: "user", content: "x" }], [{ name: "t" }], options);
    case "stream":
      return drain(provider.stream([{ role: "user", content: "x" }], options));
    default:
      return provider.generate([{ role: "user", content: "x" }], options);
  }
}

async function drain(iterable) {
  // eslint-disable-next-line no-unused-vars
  for await (const _event of iterable) {
    /* consume */
  }
}

/**
 * Contract cases that require a real transport and therefore attach in Phase 3
 * with the first HTTP adapter. Listed so the gap is recorded rather than
 * quietly forgotten (docs/backend/12-testing.md#what-every-adapter-must-prove).
 */
export const TRANSPORT_CASES = Object.freeze([
  "429 with a quota body maps to quota; without one maps to rate_limit",
  "Retry-After is parsed into retryAfter",
  "401/403 maps to auth; 5xx maps to outage; 400 maps to api_error",
  "connection refused maps to outage",
  "an SSE frame split across TCP chunks is buffered, not dropped",
  "multiple SSE frames in one chunk are all parsed",
  "a malformed SSE frame is skipped and the stream continues",
  "the provider terminator ([DONE]) is never emitted as content",
  "empty delta frames are dropped, not forwarded",
  "the upstream reader is released on early exit",
]);
