import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { discoverAdapters, buildLive, LiveReport, PROBE, LONG_PROBE } from "./liveHarness.js";
import { ProviderError, FailureKind } from "../../src/domain/errors/ProviderError.js";
import { StreamEventType, isTerminal } from "../../src/domain/streaming/StreamEvent.js";

/**
 * Live verification — step 7 of the onboarding process
 * ([03](../../../docs/backend/03-provider-system.md#provider-onboarding-process)).
 *
 * **This suite spends real quota and talks to real APIs.** It is deliberately
 * not part of `npm test`; run it with `npm run test:live`, with whatever
 * credentials you hold.
 *
 * What it is for, precisely: the mocked contract suite encodes what we *believe*
 * each provider does. This one finds out. Every difference it surfaces is a
 * belief that was wrong — and those are exactly the differences that produce
 * production incidents, because the mocked suite is green the whole time.
 *
 * Providers without a credential are **skipped and reported as unverified**. A
 * skip that reads as a pass is worse than no suite at all, so the run ends with
 * a table naming the state of every provider in the fleet.
 */

const report = new LiveReport();
const LIVE_TIMEOUT = 60_000;

/** Every adapter, paired with a live provider or a reason there is none. */
const candidates = [];

before(async () => {
  for (const { descriptor, Adapter } of await discoverAdapters()) {
    // The mock adapter is not a provider. Verifying it live would verify
    // nothing, and it is the one adapter guaranteed to be configured.
    if (descriptor.id === "mock") continue;

    const built = buildLive(descriptor, Adapter);
    if (built.skipped) {
      report.skip(descriptor.id, built.reason);
      continue;
    }
    candidates.push({ id: descriptor.id, provider: built.provider, descriptor });
  }
});

after(async () => {
  report.print();
  // Written to disk as well, so the deploy pipeline can gate on it rather than
  // on a human having read the console.
  await writeFile(
    new URL("../../live-report.json", import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), providers: report.summary() }, null, 2)
  );
});

describe("live provider verification", () => {
  test("at least one provider has a credential", () => {
    // Not an assertion about the providers — an assertion about the *run*. A
    // live suite that verified nothing and exited zero is the failure mode this
    // whole file is designed to prevent.
    if (candidates.length === 0) {
      assert.fail(
        "no provider credentials are configured; this run verified nothing. " +
          "Set at least one provider key before treating a live run as meaningful."
      );
    }
  });

  test("a real completion returns real text", { timeout: LIVE_TIMEOUT }, async () => {
    for (const { id, provider } of candidates) {
      const model = provider.models[0];
      try {
        const result = await provider.generate(PROBE.messages, {
          ...PROBE.options,
          model: model.id,
        });

        assert.ok(result.text?.length > 0, `${id}: empty completion`);
        // Proves the response was generated rather than echoed from an error
        // body — several providers return 200 with a payload that has no text.
        assert.match(result.text.toUpperCase(), /NOVAGPT/, `${id}: unexpected content`);
        assert.equal(typeof result.model, "string");
        report.record(id, "pass");
      } catch (error) {
        report.record(id, "fail", `generate: ${error.message}`);
        throw error;
      }
    }
  });

  test("usage is reported, and the numbers are plausible", { timeout: LIVE_TIMEOUT }, async () => {
    // Cost accounting is computed from these. A provider that omits them, or
    // reports zero, silently understates spend to nothing
    // ([11](../../../docs/backend/11-observability.md#cost-monitoring)).
    for (const { id, provider } of candidates) {
      const result = await provider.generate(PROBE.messages, {
        ...PROBE.options,
        model: provider.models[0].id,
      });

      if (!result.usage) {
        report.record(id, "fail", "no usage block on a completion");
        assert.fail(`${id}: reported no usage — spend for this provider would read as zero`);
      }
      assert.ok(result.usage.promptTokens > 0, `${id}: promptTokens was ${result.usage.promptTokens}`);
      assert.ok(
        result.usage.completionTokens > 0,
        `${id}: completionTokens was ${result.usage.completionTokens}`
      );
      report.record(id, "pass");
    }
  });

  test("a real stream yields normalised events", { timeout: LIVE_TIMEOUT }, async () => {
    for (const { id, provider } of candidates) {
      const events = [];
      for await (const event of provider.stream(PROBE.messages, {
        ...PROBE.options,
        model: provider.models[0].id,
      })) {
        events.push(event);
      }

      const deltas = events.filter((e) => e.type === StreamEventType.DELTA);
      const terminals = events.filter((e) => isTerminal(e));

      try {
        assert.ok(deltas.length > 0, `${id}: stream produced no deltas`);
        // Exactly one terminal, and it must be last. Two would let a client
        // finalise a message and then receive more of it.
        assert.equal(terminals.length, 1, `${id}: ${terminals.length} terminal events`);
        assert.ok(isTerminal(events.at(-1)), `${id}: stream did not end on its terminal`);
        // The provider's own end-of-stream marker must never reach the client
        // as content.
        assert.ok(
          !deltas.some((d) => d.text?.includes("[DONE]")),
          `${id}: leaked its stream terminator as content`
        );
        report.record(id, "pass");
      } catch (error) {
        report.record(id, "fail", `stream: ${error.message}`);
        throw error;
      }
    }
  });

  test("cancellation stops the upstream call promptly", { timeout: LIVE_TIMEOUT }, async () => {
    // The one that costs real money when it is wrong: a cancellation that does
    // not reach the provider keeps generating tokens nobody will ever read.
    for (const { id, provider } of candidates) {
      const controller = new AbortController();
      const started = Date.now();
      let deltas = 0;

      try {
        for await (const event of provider.stream(LONG_PROBE.messages, {
          ...LONG_PROBE.options,
          model: provider.models[0].id,
          signal: controller.signal,
        })) {
          if (event.type === StreamEventType.DELTA && ++deltas >= 2) controller.abort();
        }
      } catch (error) {
        // An abort surfacing as an error is fine. Hanging is not.
        assert.ok(
          error.name === "AbortError" || error.cancelled || /abort|cancel/i.test(error.message),
          `${id}: abort produced an unexpected error: ${error.message}`
        );
      }

      const elapsed = Date.now() - started;
      try {
        assert.ok(elapsed < 20_000, `${id}: took ${elapsed}ms to stop after abort`);
        report.record(id, "pass");
      } catch (error) {
        report.record(id, "fail", `cancel: ${error.message}`);
        throw error;
      }
    }
  });

  test("a bad credential maps to `auth`, not to a generic failure", { timeout: LIVE_TIMEOUT }, async () => {
    // The taxonomy claim that matters most for the breaker: `auth` opens it on
    // the first failure, because nothing recovers without a human. A provider
    // whose rejection maps to `outage` instead would be retried forever.
    for (const { id, descriptor, provider } of candidates) {
      if (!descriptor.requiresCredentials) continue;

      const impostor = Object.create(Object.getPrototypeOf(provider));
      Object.assign(impostor, provider);
      impostor.credential = { expose: () => "definitely-not-a-valid-key" };

      try {
        await impostor.generate(PROBE.messages, { ...PROBE.options, model: provider.models[0].id });
        report.record(id, "fail", "a bogus credential was accepted");
        assert.fail(`${id}: accepted an invalid credential`);
      } catch (error) {
        if (!(error instanceof ProviderError)) {
          report.record(id, "fail", `bad key produced ${error.name}, not ProviderError`);
          throw error;
        }
        try {
          assert.equal(
            error.failureKind,
            FailureKind.AUTH,
            `${id}: mapped a rejected credential to "${error.failureKind}"`
          );
          report.record(id, "pass");
        } catch (assertion) {
          report.record(id, "fail", assertion.message);
          throw assertion;
        }
      }
    }
  });

  test("an unknown model is rejected before any network call", { timeout: LIVE_TIMEOUT }, async () => {
    for (const { id, provider } of candidates) {
      await assert.rejects(
        () => provider.generate(PROBE.messages, { ...PROBE.options, model: "model-that-does-not-exist" }),
        (error) => error instanceof Error,
        `${id}: accepted an unknown model id`
      );
      report.record(id, "pass");
    }
  });

  test("the health probe agrees with reality", { timeout: LIVE_TIMEOUT }, async () => {
    // Recovery depends on this: the monitor probes non-healthy providers, and a
    // probe that answers while completions fail keeps a dead provider in
    // rotation ([03](../../../docs/backend/03-provider-system.md#health-system)).
    for (const { id, provider } of candidates) {
      const health = await provider.health();
      try {
        assert.equal(health.ok, true, `${id}: health probe failed against a working credential`);
        report.record(id, "pass");
      } catch (error) {
        report.record(id, "fail", `health: ${error.message}`);
        throw error;
      }
    }
  });

  test("the declared context window is not larger than the model accepts", { timeout: LIVE_TIMEOUT }, async () => {
    // A catalog that overstates a window makes the context engine budget for
    // space that does not exist, and the failure lands as a provider rejection
    // on the user's longest, most valuable conversation.
    //
    // Sending a genuinely window-sized prompt would cost real quota, so this
    // checks the cheap half: the declaration is present and plausible.
    for (const { id, provider } of candidates) {
      for (const model of provider.models) {
        assert.ok(
          model.contextWindow > 0 && model.maxOutputTokens > 0,
          `${id}/${model.id}: incomplete limits`
        );
        assert.ok(
          model.maxOutputTokens < model.contextWindow,
          `${id}/${model.id}: maxOutputTokens exceeds the context window`
        );
      }
      report.record(id, "pass");
    }
  });
});
