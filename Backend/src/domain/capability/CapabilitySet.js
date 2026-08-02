import { CapabilityKind } from "./Capability.js";
import { capabilityRegistry } from "./CapabilityRegistry.js";

/**
 * One model's capabilities, validated and immutable.
 *
 * The invariant this type exists to hold: **a model never advertises a
 * capability it cannot deliver**. Construction validates against the registry
 * and normalises undeclared binaries to false, so a typo'd axis is a startup
 * error rather than a routing failure in front of a user.
 */
export class CapabilitySet {
  /**
   * @param {object} declared
   * @param {import("./CapabilityRegistry.js").CapabilityRegistry} [registry]
   */
  constructor(declared = {}, registry = capabilityRegistry) {
    const problems = registry.validate(declared);
    if (problems.length) {
      throw new TypeError(`Invalid capabilities: ${problems.join("; ")}`);
    }
    this.registry = registry;
    this.values = Object.freeze(registry.normalise(declared));
    Object.freeze(this);
  }

  /** True when a binary capability is present. Unknown axes are false. */
  supports(name) {
    return this.values[name] === true;
  }

  /** Raw value of any axis; `null` when undeclared. */
  value(name) {
    return this.values[name] ?? null;
  }

  /** Score on a 0-100 axis, defaulting to 50 so an unscored model ranks mid-pack. */
  score(name) {
    const value = this.values[name];
    return Number.isFinite(value) ? value : 50;
  }

  /** Every binary capability this model claims. */
  supported() {
    return Object.entries(this.values)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }

  /**
   * Narrow this set — remove claims, never add them.
   *
   * The only sanctioned way to override capability data at runtime, used by an
   * adapter that knows the catalog overstates what its endpoint accepts
   * (docs/backend/03-provider-system.md#capability-detection). Widening is
   * impossible by construction because probes and adapters cannot know a
   * capability the catalog did not declare — inferring one from a model name is
   * string matching against a convention no provider guarantees.
   */
  narrow(removals = []) {
    const next = { ...this.values };
    for (const name of removals) {
      if (this.registry.kindOf(name) === CapabilityKind.BINARY) next[name] = false;
    }
    return new CapabilitySet(next, this.registry);
  }

  toJSON() {
    return { ...this.values };
  }
}
