/**
 * Port definitions — the interfaces the domain declares and infrastructure
 * implements. In JavaScript these are JSDoc typedefs, checked by
 * `tsc --checkJs`; importing this module re-exports the types for editors.
 *
 * These live in `domain/` and not in `infrastructure/` on purpose: the
 * interface describes what the domain *needs*, not what an implementation
 * happens to offer (docs/backend/02-architecture.md#why-ports-are-owned-by-the-domain).
 */
export * from "./ClockPort.js";
export * from "./LoggerPort.js";
export * from "./CachePort.js";
export * from "./MetricsPort.js";
export * from "./HealthProbePort.js";
