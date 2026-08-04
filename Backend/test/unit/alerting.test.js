import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * The alert rules, checked as artefacts.
 *
 * > Every paging alert MUST have a runbook linked from the alert itself.
 *
 * That is an acceptance criterion in
 * docs/backend/11-observability.md#alerting, and it is exactly the kind of rule
 * that holds until the night someone adds an alert in a hurry. Asserting it
 * costs one test; discovering it at 3am costs considerably more — an alert
 * without a runbook is a notification that someone's night is ruined, with no
 * information about how to fix it.
 */

const OPS = new URL("../../../ops/", import.meta.url).pathname;
const exists = (path) => access(path).then(() => true, () => false);

/**
 * A deliberately small YAML reader.
 *
 * It understands only the shape this one file has. Pulling in a YAML parser to
 * assert something about our own fixed-format file would be a dependency on the
 * authentication-adjacent path for no benefit — and a real parser would happily
 * accept a restructured file that this test is meant to notice.
 */
async function rules() {
  const text = await readFile(join(OPS, "prometheus/alerts.yml"), "utf8");
  const found = [];
  let current = null;

  for (const line of text.split("\n")) {
    const alert = /^\s*- alert:\s*(\S+)/.exec(line);
    if (alert) {
      current = { name: alert[1], severity: null, runbook: null, hasFor: false, expr: false };
      found.push(current);
      continue;
    }
    if (!current) continue;
    if (/severity:\s*page/.test(line)) current.severity = "page";
    if (/severity:\s*warning/.test(line)) current.severity = "warning";
    if (/runbook:\s*"([^"]+)"/.test(line)) current.runbook = /runbook:\s*"([^"]+)"/.exec(line)[1];
    if (/^\s*for:\s/.test(line)) current.hasFor = true;
    if (/^\s*expr:/.test(line)) current.expr = true;
  }
  return found;
}

describe("alert rules", () => {
  test("the file parses into a plausible set of rules", async () => {
    const parsed = await rules();
    assert.ok(parsed.length >= 10, `only found ${parsed.length} rules`);
    assert.ok(parsed.every((r) => r.expr), "every rule needs an expression");
    assert.ok(parsed.every((r) => r.severity), "every rule needs a severity");
  });

  test("every paging alert links a runbook that exists", async () => {
    const paging = (await rules()).filter((r) => r.severity === "page");
    assert.ok(paging.length >= 5, "the documented paging set is five alerts");

    const broken = [];
    for (const rule of paging) {
      if (!rule.runbook) broken.push(`${rule.name}: no runbook`);
      else if (!(await exists(join(OPS, "..", rule.runbook)))) {
        broken.push(`${rule.name}: runbook missing at ${rule.runbook}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  test("each runbook says what the alert means and how to verify recovery", async () => {
    // A runbook that only says "restart it" is not a runbook. The four headings
    // below are the ones that make an alert actionable by someone who did not
    // write the system.
    const paging = (await rules()).filter((r) => r.severity === "page" && r.runbook);

    for (const rule of paging) {
      const text = await readFile(join(OPS, "..", rule.runbook), "utf8");
      for (const heading of ["What it means", "Confirm", "Fix", "Verify recovery"]) {
        assert.ok(
          text.includes(heading),
          `${rule.runbook} is missing a "${heading}" section`
        );
      }
    }
  });

  test("no single provider failing can page anyone", async () => {
    // The entire architecture exists so that one provider going down is a
    // non-event. Paging on it would mean paging on the system working
    // correctly, and an on-call rotation woken for non-events stops responding
    // to real ones.
    const paging = (await rules()).filter((r) => r.severity === "page");
    const perProvider = paging.filter((r) => /ProviderDegraded|ProviderDown/.test(r.name));
    assert.deepEqual(perProvider, []);
  });

  test("paging alerts wait before firing, except the one that must not", async () => {
    // A `for` clause is what stops a transient blip paging someone. The
    // exception is a rejected platform key: nothing recovers without a human,
    // so waiting only delays the fix.
    for (const rule of (await rules()).filter((r) => r.severity === "page")) {
      if (rule.name === "NovaPlatformKeyRejected") {
        assert.equal(rule.hasFor, false, "a dead key should page immediately");
      } else {
        assert.ok(rule.hasFor, `${rule.name} would page on a single scrape`);
      }
    }
  });
});
