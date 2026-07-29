/**
 * The capability vocabulary.
 *
 * Capabilities are declared as **data**, never inferred from a model id
 * (docs/backend/15-decisions.md#adr-006--capabilities-as-data-not-code). There is
 * no code path in NovaGPT that branches on a model name.
 *
 * Three kinds, and the kind determines how the router may use the value
 * (docs/backend/05-capability-matrix.md#the-capability-axes):
 *
 *   BINARY   present or absent. A hard filter — a model without `vision`
 *            cannot serve a vision request at any speed or price.
 *   NUMERIC  a threshold, then a ranking input. Filter on `>= required`.
 *   SCORED   0-100, relative, maintainer-estimated. **Ranking only, never a
 *            filter** — the scores are not calibrated across providers, and an
 *            uncalibrated number used as a gate produces confidently wrong
 *            exclusions.
 */

export const CapabilityKind = {
  BINARY: "binary",
  NUMERIC: "numeric",
  SCORED: "scored",
};

/**
 * The canonical axes.
 *
 * Axes are declared for capabilities no Phase 1 provider has (`imageGen`,
 * `audio`). That is deliberate: the matrix is the contract for *future*
 * providers as much as current ones, and an axis defined now means adding an
 * audio provider later is a data change rather than a schema migration plus a
 * router change. The cost of an unused axis is one column of `false`.
 */
export const CAPABILITY_AXES = Object.freeze([
  /* ---- binary ---- */
  { name: "streaming", kind: CapabilityKind.BINARY, description: "Incremental token delivery." },
  { name: "vision", kind: CapabilityKind.BINARY, description: "Accepts image input alongside text." },
  {
    name: "json",
    kind: CapabilityKind.BINARY,
    description: "Guarantees syntactically valid JSON output.",
  },
  {
    name: "structuredOutput",
    kind: CapabilityKind.BINARY,
    // Separate from `json` on purpose. `json` guarantees *parseable* output;
    // this guarantees *schema-conformant* output. A caller needing a specific
    // shape that routes to a json-only model gets valid JSON with the wrong
    // fields — a bug that surfaces downstream, far from its cause.
    description: "Enforces a caller-supplied schema, not merely valid JSON.",
    implies: ["json"],
  },
  { name: "toolCalling", kind: CapabilityKind.BINARY, description: "Native tool-call protocol." },
  {
    name: "functionCalling",
    kind: CapabilityKind.BINARY,
    // A different wire protocol from `toolCalling`, with a different response
    // shape. Several providers support one and not the other; collapsing them
    // would make the router promise a protocol the adapter cannot speak.
    description: "Legacy OpenAI `functions` parameter.",
  },
  { name: "pdf", kind: CapabilityKind.BINARY, description: "Accepts PDF as native input." },
  { name: "imageGen", kind: CapabilityKind.BINARY, description: "Produces images." },
  { name: "audio", kind: CapabilityKind.BINARY, description: "Accepts audio or produces speech." },
  { name: "video", kind: CapabilityKind.BINARY, description: "Accepts video input." },
  { name: "embeddings", kind: CapabilityKind.BINARY, description: "Produces vectors." },

  /* ---- numeric ---- */
  {
    name: "contextWindow",
    kind: CapabilityKind.NUMERIC,
    unit: "tokens",
    description: "Total window shared by prompt and completion.",
  },
  {
    name: "maxOutputTokens",
    kind: CapabilityKind.NUMERIC,
    unit: "tokens",
    // Separate from contextWindow because they are separate limits. Several
    // models advertise 128K context but cap output at 8K; a model that can
    // read a long conversation but not write the requested reply truncates
    // mid-sentence, which looks like a quality problem and is a routing bug.
    description: "Maximum tokens the model will generate in one reply.",
  },

  /* ---- scored ---- */
  { name: "reasoning", kind: CapabilityKind.SCORED, description: "Multi-step reasoning, maths." },
  { name: "coding", kind: CapabilityKind.SCORED, description: "Code generation and comprehension." },
  { name: "multilingual", kind: CapabilityKind.SCORED, description: "Non-English quality." },
  { name: "speed", kind: CapabilityKind.SCORED, description: "Relative tokens/sec under load." },
]);

export const BINARY_CAPABILITIES = Object.freeze(
  CAPABILITY_AXES.filter((a) => a.kind === CapabilityKind.BINARY).map((a) => a.name)
);
export const NUMERIC_CAPABILITIES = Object.freeze(
  CAPABILITY_AXES.filter((a) => a.kind === CapabilityKind.NUMERIC).map((a) => a.name)
);
export const SCORED_CAPABILITIES = Object.freeze(
  CAPABILITY_AXES.filter((a) => a.kind === CapabilityKind.SCORED).map((a) => a.name)
);

/** Economic tiers and cost bands. Coarse on purpose — exact prices rot. */
export const Tier = Object.freeze({ FREE: "free", PAID: "paid" });
export const CostBand = Object.freeze(["Free", "$", "$$", "$$$"]);
