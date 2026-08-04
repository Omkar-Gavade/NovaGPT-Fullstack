/**
 * A frozen view of the fleet at one instant.
 *
 * The routing policy receives this as an **argument** rather than querying a
 * registry. That single choice is what makes the policy pure, and it buys three
 * things that matter more than the indirection costs
 * (docs/backend/04-router.md#request-lifecycle):
 *
 *   1. Every routing decision is a unit test with no fixtures and no I/O, so
 *      the 20-row decision table can be covered exhaustively in milliseconds.
 *   2. The primary and its fallbacks are ranked against a *consistent* world.
 *      Re-querying health mid-failover would rank a fallback against different
 *      state than the primary, making failover irreproducible and untestable.
 *   3. A decision can be replayed later from its recorded snapshot, which is
 *      what makes "why did this request go to Groq?" answerable after the fact.
 */

export class ProviderHealthEntry {
  /**
   * @param {object} raw
   * @param {string} raw.providerId
   * @param {boolean} raw.available   configured, enabled, breaker allows
   * @param {number} raw.health       0..1
   * @param {number|null} raw.latencyMs measured rolling average, null if unproven
   * @param {string} raw.status       projected status for diagnostics
   * @param {number} [raw.priority]   operator bias; higher wins
   * @param {boolean} [raw.dark]      shipped dark: eligible, but ranked last
   */
  constructor(raw = {}) {
    this.providerId = raw.providerId;
    this.available = raw.available === true;
    this.health = Number.isFinite(raw.health) ? raw.health : 0;
    this.latencyMs = Number.isFinite(raw.latencyMs) ? raw.latencyMs : null;
    this.status = raw.status ?? "unknown";
    this.priority = Number.isFinite(raw.priority) ? raw.priority : 0;
    // Dark is about *trust*, not health: the provider may be perfectly healthy
    // and simply has not yet earned user traffic
    // (docs/backend/03-provider-system.md#provider-onboarding-process).
    this.dark = raw.dark === true;
    Object.freeze(this);
  }
}

export class HealthSnapshot {
  /**
   * @param {ProviderHealthEntry[]|object[]} entries
   * @param {number} [takenAtMs]
   */
  constructor(entries = [], takenAtMs = 0) {
    /** @type {Map<string, ProviderHealthEntry>} */
    this.entries = new Map();
    for (const raw of entries) {
      const entry = raw instanceof ProviderHealthEntry ? raw : new ProviderHealthEntry(raw);
      this.entries.set(entry.providerId, entry);
    }
    this.takenAtMs = takenAtMs;
    Object.freeze(this);
  }

  /**
   * A provider absent from the snapshot is treated as unavailable, never as
   * healthy-by-default. A model whose provider was unregistered between
   * snapshot and decision must not be selected.
   */
  get(providerId) {
    return this.entries.get(providerId) ?? MISSING;
  }

  isAvailable(providerId) {
    return this.get(providerId).available;
  }

  healthOf(providerId) {
    return this.get(providerId).health;
  }

  latencyOf(providerId) {
    return this.get(providerId).latencyMs;
  }

  priorityOf(providerId) {
    return this.get(providerId).priority;
  }

  isDark(providerId) {
    return this.get(providerId).dark;
  }

  get availableProviderIds() {
    return [...this.entries.values()].filter((e) => e.available).map((e) => e.providerId);
  }

  get size() {
    return this.entries.size;
  }
}

const MISSING = new ProviderHealthEntry({
  providerId: "(unknown)",
  available: false,
  health: 0,
  status: "unregistered",
});
