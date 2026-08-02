/**
 * In-process cache implementing CachePort.
 *
 * Not a stub. This is the documented degraded mode when Redis is unreachable,
 * and the correct implementation for a single-instance deployment
 * (docs/backend/08-storage.md#redis-must-be-optional-and-what-that-costs).
 *
 * Making it a real implementation of the same interface — rather than a set of
 * `if (redis)` branches in callers — is what makes the degraded path testable.
 * An untested degradation path is a guess, and it gets discovered during the
 * incident it was designed for.
 *
 * The scope limitation is honest and stated: state is per-instance, so rate
 * limits and breaker state are per-instance too.
 */
export class InMemoryCache {
  kind = "memory";
  name = "cache";
  /** Not critical: its loss degrades limits and sharing, it does not stop serving. */
  critical = false;

  /**
   * @param {object} deps
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} deps.clock
   * @param {number} [deps.maxEntries] bound so a cache cannot exhaust the heap
   */
  constructor({ clock, maxEntries = 10_000 }) {
    this.clock = clock;
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value: unknown, expiresAt: number|null}>} */
    this.store = new Map();
  }

  #live(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key) {
    return this.#live(key)?.value ?? null;
  }

  async set(key, value, ttlMs) {
    this.#evictIfNeeded();
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? this.clock.now() + ttlMs : null,
    });
  }

  async del(key) {
    this.store.delete(key);
  }

  /**
   * Atomic within this process because JavaScript is single-threaded — no
   * interleaving is possible between the read and the write below.
   */
  async increment(key, ttlMs) {
    const entry = this.#live(key);
    const next = (typeof entry?.value === "number" ? entry.value : 0) + 1;
    this.store.set(key, {
      value: next,
      // The window is set by the first increment and not extended by later
      // ones — otherwise sustained traffic would keep pushing the expiry out
      // and the counter would never reset.
      expiresAt: entry?.expiresAt ?? this.clock.now() + ttlMs,
    });
    return next;
  }

  /** Always healthy: there is nothing to be disconnected from. */
  async isHealthy() {
    return true;
  }

  async probe() {
    return {
      name: this.name,
      critical: this.critical,
      ok: true,
      latencyMs: 0,
      detail: "in-memory (per-instance scope)",
    };
  }

  async close() {
    this.store.clear();
  }

  /**
   * Drop expired entries first; if that frees nothing, drop oldest-inserted.
   * Map preserves insertion order, so the first key is the oldest.
   */
  #evictIfNeeded() {
    if (this.store.size < this.maxEntries) return;
    const now = this.clock.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}
