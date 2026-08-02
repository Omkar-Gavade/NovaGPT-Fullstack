import {
  CAPABILITY_AXES,
  CapabilityKind,
  BINARY_CAPABILITIES,
  NUMERIC_CAPABILITIES,
  SCORED_CAPABILITIES,
} from "./Capability.js";

/**
 * The authoritative registry of capability axes.
 *
 * This is where "capability metadata must be centralized" is actually enforced.
 * Every model's declared capabilities are validated against it, so an axis that
 * does not exist here cannot be claimed by a model, and a value of the wrong
 * kind cannot be stored. Without this, capability data degrades into an
 * untyped bag where `vision: "yes"` and `contextWindow: "128k"` pass silently
 * and fail at routing time.
 *
 * Axes are extensible at runtime (`register`) so a future capability is a data
 * change rather than an edit to this file. The built-in set is seeded from
 * `CAPABILITY_AXES`.
 */
export class CapabilityRegistry {
  constructor(axes = CAPABILITY_AXES) {
    /** @type {Map<string, object>} */
    this.axes = new Map();
    for (const axis of axes) this.register(axis);
  }

  /**
   * Declare an axis. Re-declaring an existing name is rejected rather than
   * silently overwriting: two subsystems disagreeing about what `vision` means
   * is a far worse failure than a startup error.
   */
  register(axis) {
    if (!axis?.name) throw new TypeError("A capability axis needs a name");
    if (!Object.values(CapabilityKind).includes(axis.kind)) {
      throw new TypeError(`Unknown capability kind "${axis.kind}" for "${axis.name}"`);
    }
    if (this.axes.has(axis.name)) {
      throw new Error(`Capability "${axis.name}" is already registered`);
    }
    this.axes.set(axis.name, Object.freeze({ ...axis }));
    return this;
  }

  has(name) {
    return this.axes.has(name);
  }

  get(name) {
    return this.axes.get(name) ?? null;
  }

  kindOf(name) {
    return this.axes.get(name)?.kind ?? null;
  }

  list() {
    return [...this.axes.values()];
  }

  names() {
    return [...this.axes.keys()];
  }

  namesOfKind(kind) {
    return this.list()
      .filter((a) => a.kind === kind)
      .map((a) => a.name);
  }

  /** True when this axis may be used as a hard filter. Scored axes may not. */
  isFilterable(name) {
    const kind = this.kindOf(name);
    return kind === CapabilityKind.BINARY || kind === CapabilityKind.NUMERIC;
  }

  /**
   * Validate a raw capability declaration.
   *
   * Returns a list of problems rather than throwing on the first, so a badly
   * written catalog entry reports every mistake at once instead of one per
   * edit-and-rerun cycle.
   *
   * @returns {string[]} problems, empty when valid
   */
  validate(declared = {}) {
    const problems = [];

    for (const [name, value] of Object.entries(declared)) {
      const axis = this.axes.get(name);
      if (!axis) {
        problems.push(`unknown capability "${name}"`);
        continue;
      }
      switch (axis.kind) {
        case CapabilityKind.BINARY:
          if (typeof value !== "boolean") {
            problems.push(`"${name}" must be a boolean, got ${typeof value}`);
          }
          break;
        case CapabilityKind.NUMERIC:
          if (!Number.isFinite(value) || value <= 0) {
            problems.push(`"${name}" must be a positive number, got ${JSON.stringify(value)}`);
          }
          break;
        case CapabilityKind.SCORED:
          if (!Number.isFinite(value) || value < 0 || value > 100) {
            problems.push(`"${name}" must be a score 0-100, got ${JSON.stringify(value)}`);
          }
          break;
      }
    }

    // An implication is a claim that cannot be half-true: a model enforcing a
    // schema necessarily produces valid JSON. Allowing the pair to disagree
    // would let the router satisfy a schema requirement with a model that has
    // explicitly said it cannot produce parseable output.
    for (const axis of this.axes.values()) {
      if (!axis.implies || declared[axis.name] !== true) continue;
      for (const implied of axis.implies) {
        if (declared[implied] === false) {
          problems.push(`"${axis.name}" implies "${implied}", which is declared false`);
        }
      }
    }

    return problems;
  }

  /**
   * Fill in the defaults for anything undeclared.
   *
   * Undeclared binary capabilities default to **false**, never true.
   * Over-advertising costs a failed request, a wasted quota unit, and a
   * user-visible error; under-advertising costs a marginally worse route the
   * user never notices. The asymmetry is large, so silence means "no"
   * (docs/backend/05-capability-matrix.md#design-principles).
   */
  normalise(declared = {}) {
    const out = {};
    for (const name of BINARY_CAPABILITIES) out[name] = declared[name] === true;
    for (const name of NUMERIC_CAPABILITIES) {
      if (Number.isFinite(declared[name])) out[name] = declared[name];
    }
    for (const name of SCORED_CAPABILITIES) {
      if (Number.isFinite(declared[name])) out[name] = declared[name];
    }
    // Axes registered after construction are carried through as declared.
    for (const [name, value] of Object.entries(declared)) {
      if (!(name in out) && this.has(name)) out[name] = value;
    }
    return out;
  }
}

/** The default registry, seeded with the canonical axes. */
export const capabilityRegistry = new CapabilityRegistry();
