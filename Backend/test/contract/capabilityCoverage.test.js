import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { discoverAdapters } from "../live/liveHarness.js";
import { costTable } from "../../src/infrastructure/providers/catalog/CostTable.js";

/**
 * The coverage rule, enforced rather than asserted in prose.
 *
 * > The set was validated against one rule: **every capability must be served
 * > by at least two providers**, so failover never has to drop a required
 * > capability.
 *
 * That rule lived only in a table in
 * [05](../../../docs/backend/05-capability-matrix.md#coverage-analysis--why-this-set-is-sufficient),
 * which meant it held exactly as long as someone remembered to re-check the
 * table by hand. A capability served by one provider is one whose failover
 * silently does not exist — the request just fails when that provider is down,
 * and nothing surfaces the risk until it happens.
 *
 * Reads the shipped adapters, so it is the real fleet rather than a copy of it.
 */

const FLEET = await discoverAdapters();
const REAL = FLEET.filter((m) => m.descriptor.id !== "mock");

const providersOffering = (predicate) =>
  REAL.filter(({ descriptor }) => descriptor.models.some(predicate)).map((m) => m.descriptor.id);

describe("capability coverage", () => {
  test("the fleet is the one the documentation describes", () => {
    assert.ok(REAL.length >= 8, `expected at least 8 real adapters, found ${REAL.length}`);
  });

  for (const capability of ["vision", "toolCalling", "json", "streaming"]) {
    test(`${capability} is served by at least two providers`, () => {
      const offering = providersOffering((m) => m.capabilities?.[capability] === true);
      assert.ok(
        offering.length >= 2,
        `${capability} is served only by [${offering.join(", ")}] — failover would drop it`
      );
    });
  }

  for (const window of [128_000, 256_000, 1_000_000]) {
    test(`context of ${window.toLocaleString()} is served by at least two providers`, () => {
      const offering = providersOffering((m) => (m.capabilities?.contextWindow ?? 0) >= window);
      assert.ok(
        offering.length >= 2,
        `a ${window.toLocaleString()}-token window is served only by [${offering.join(", ")}]. ` +
          "A conversation that large has no failover destination."
      );
    });
  }

  test("the two providers above 1M are different vendors", () => {
    // Redundancy that shares a vendor closes the gap on paper and not in an
    // outage. This is the check that would catch someone "fixing" the gap by
    // adding a second route to Google.
    const offering = providersOffering((m) => (m.capabilities?.contextWindow ?? 0) >= 1_000_000);
    assert.equal(new Set(offering).size, offering.length);
    assert.ok(offering.length >= 2, `only [${offering.join(", ")}] serve 1M context`);
  });

  test("every model in the fleet has a price entry", () => {
    // An unpriced model records `null` cost, which is honest and invisible: the
    // spend dashboard reports the fleet getting cheaper as traffic moves onto
    // it (ADR-025). This is the quarterly audit, run continuously.
    const unpriced = [];
    for (const { descriptor } of REAL) {
      for (const model of descriptor.models) {
        // Embeddings models are priced separately and often free; they are
        // still expected to have an entry.
        if (!costTable.priceFor(model.id, new Date().toISOString())) {
          unpriced.push(`${descriptor.id}/${model.id}`);
        }
      }
    }
    assert.deepEqual(unpriced, [], "these models would report null cost forever");
  });

  test("a model claiming live verification carries a date", () => {
    // `verifiedAt` is the record that an adapter has been called against the
    // real API. A model that claims verification without saying when is the
    // kind of claim that ages into a lie.
    const bad = [];
    for (const { descriptor } of REAL) {
      for (const model of descriptor.models) {
        if (model.verifiedAt === undefined) bad.push(`${descriptor.id}/${model.id}`);
        else if (model.verifiedAt !== null && Number.isNaN(Date.parse(model.verifiedAt))) {
          bad.push(`${descriptor.id}/${model.id} (unparseable: ${model.verifiedAt})`);
        }
      }
    }
    assert.deepEqual(bad, [], "verifiedAt must be a date or an explicit null");
  });
});
