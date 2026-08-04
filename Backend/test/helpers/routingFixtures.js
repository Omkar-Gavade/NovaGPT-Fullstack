import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { RequirementSet } from "../../src/domain/capability/RequirementSet.js";
import { HealthSnapshot } from "../../src/domain/routing/HealthSnapshot.js";

/**
 * Builders for routing tests.
 *
 * The routing policy is pure, so a test needs only plain data — no registry, no
 * clock, no network. These builders exist so a test reads as the *scenario* it
 * describes rather than as object construction.
 */

/** A model, with sensible defaults so a test names only what it cares about. */
export function model(id, overrides = {}) {
  const { provider = id.split("-")[0], capabilities = {}, ...rest } = overrides;
  return new ModelDescriptor({
    id,
    provider,
    displayName: overrides.displayName ?? id,
    capabilities: { contextWindow: 128_000, maxOutputTokens: 4096, speed: 80, ...capabilities },
    tier: "free",
    costBand: "Free",
    ...rest,
  });
}

/** A health snapshot from a compact `{providerId: {…}}` map. */
export function snapshot(providers = {}, takenAtMs = 0) {
  return new HealthSnapshot(
    Object.entries(providers).map(([providerId, entry]) => ({
      providerId,
      available: entry.available !== false,
      health: entry.health ?? 1,
      latencyMs: entry.latencyMs ?? null,
      status: entry.status ?? "ready",
      priority: entry.priority ?? 0,
    })),
    takenAtMs
  );
}

/** Every provider in the catalog, healthy. The common baseline. */
export function allHealthy(catalog, overrides = {}) {
  const providers = {};
  for (const m of catalog) providers[m.provider] ??= {};
  return snapshot({ ...providers, ...overrides });
}

export const requirements = (required = {}) => new RequirementSet(required);
export const noRequirements = () => new RequirementSet({});

/**
 * A two-provider catalog: one fast text model, one slower vision model.
 * Enough to exercise capability filtering, tier and latency ordering without
 * a test having to describe a whole fleet.
 */
export function basicCatalog() {
  return [
    model("alpha-fast", {
      provider: "alpha",
      capabilities: { streaming: true, json: true, toolCalling: true, speed: 95 },
    }),
    model("beta-vision", {
      provider: "beta",
      capabilities: { streaming: true, vision: true, json: true, speed: 60 },
    }),
  ];
}
