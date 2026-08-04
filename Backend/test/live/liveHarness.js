import { ProviderDiscovery } from "../../src/infrastructure/providers/registry/ProviderDiscovery.js";
import { ProviderLoader } from "../../src/infrastructure/providers/registry/ProviderLoader.js";
import { ProviderFactory } from "../../src/infrastructure/providers/registry/ProviderFactory.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * Building real adapters against real credentials.
 *
 * **The distinction this directory exists to draw.** Everything under
 * `test/contract/` runs against a mocked HTTP layer: it verifies that an
 * adapter behaves the way we *believe* its provider does. That is necessary and
 * it is not sufficient — a mock cannot tell you that a provider returns `200`
 * with an error body, that its `usage` block is absent on streamed responses,
 * or that its idea of a context window differs from its documentation.
 *
 * Only a live call reveals those, which is why step 7 of the onboarding process
 * is a keyed run and why no adapter is production-supported until it has passed
 * one (docs/backend/03-provider-system.md#provider-onboarding-process).
 *
 * **A provider with no credential is SKIPPED, never failed.** Most contributors
 * will hold keys for one or two providers, and a suite that goes red for the
 * six they did not sign up for is a suite they stop running. What must never
 * happen is a skip that reads as a pass — hence `report()`, which prints the
 * verification state of every provider in the fleet at the end of the run.
 */

const clock = new SystemClock();

/** Every adapter the repository ships, whether or not it has a credential. */
export async function discoverAdapters() {
  const discovery = new ProviderDiscovery({ logger: silentLogger });
  const loader = new ProviderLoader({ logger: silentLogger });

  const found = await discovery.discover();
  const loaded = [];
  for (const entry of found) {
    const module = await loader.load(entry);
    if (module?.descriptor && module?.Adapter) loaded.push(module);
  }
  return loaded;
}

/**
 * Build a real, credentialled adapter, or explain why not.
 *
 * Uses the production factory rather than constructing adapters directly: the
 * credential resolution, the allowlist, and the "configured" determination are
 * all things live verification should be exercising, not bypassing.
 */
export function buildLive(descriptor, Adapter) {
  const factory = new ProviderFactory({
    policy: { allowlist: null, denylist: [] },
    env: process.env,
    logger: silentLogger,
    clock,
  });

  const result = factory.create(descriptor, Adapter);
  if (!result.provider) return { skipped: true, reason: result.reason ?? "not configured" };
  return { skipped: false, provider: result.provider };
}

/**
 * The record of what was actually verified.
 *
 * Printed at the end of a run and written to `live-report.json`, because "the
 * live suite passed" is meaningless without knowing which providers it touched.
 * A run that verified one provider and skipped seven is a useful result; a run
 * that reports "green" without saying so is a misleading one.
 */
export class LiveReport {
  constructor() {
    this.providers = new Map();
  }

  record(provider, state, detail = null) {
    const existing = this.providers.get(provider) ?? { checks: [] };
    existing.checks.push({ state, detail });
    this.providers.set(provider, existing);
  }

  skip(provider, reason) {
    this.providers.set(provider, { skipped: true, reason, checks: [] });
  }

  summary() {
    const rows = [];
    for (const [provider, entry] of this.providers) {
      if (entry.skipped) {
        rows.push({ provider, verified: false, status: "SKIPPED", reason: entry.reason });
        continue;
      }
      const failed = entry.checks.filter((c) => c.state === "fail");
      rows.push({
        provider,
        verified: failed.length === 0,
        status: failed.length === 0 ? "VERIFIED" : "FAILED",
        checks: entry.checks.length,
        failures: failed.map((f) => f.detail),
      });
    }
    return rows.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  print() {
    const rows = this.summary();
    process.stdout.write("\n  Live verification\n  ─────────────────\n");
    for (const row of rows) {
      const note = row.status === "SKIPPED" ? ` (${row.reason})` : ` — ${row.checks ?? 0} checks`;
      process.stdout.write(`  ${row.status.padEnd(9)} ${row.provider.padEnd(12)}${note}\n`);
    }
    const verified = rows.filter((r) => r.verified).length;
    process.stdout.write(`\n  ${verified} of ${rows.length} providers verified against a real API.\n\n`);
  }
}

/**
 * Small, cheap, and deterministic enough to assert on.
 *
 * Live verification spends real quota on every run, so the prompts are as short
 * as they can be while still proving something: a completion that must contain
 * a specific token proves the response was actually generated rather than
 * echoed from a cache or an error body.
 */
export const PROBE = Object.freeze({
  messages: [{ role: "user", content: "Reply with exactly the word: NOVAGPT" }],
  // Not 16. Live verification found that Gemini 2.5 charges *thinking* tokens
  // against the output budget, so a tight cap returns a truncated answer on
  // some providers and a complete one on others — which would make this probe
  // measure the cap rather than the provider. The adapter now normalises that;
  // the probe stays generous so a regression shows up as a real difference.
  options: { maxTokens: 128, temperature: 0 },
});

export const LONG_PROBE = Object.freeze({
  messages: [{ role: "user", content: "Count slowly from 1 to 40, one number per line." }],
  options: { maxTokens: 300, temperature: 0 },
});
