/**
 * Deterministic, extractive conversation compression.
 *
 * The architecture calls for model-generated summaries
 * (docs/backend/06-context-engine.md#which-model-summarises). That needs a
 * provider call, which this phase deliberately does not make — so compression
 * here is **extractive and deterministic**: it selects and structures existing
 * text rather than generating new text.
 *
 * That constraint is a feature, not a placeholder:
 *
 *   - **Deterministic.** The same span always compresses to the same summary, so
 *     a context bug is reproducible from a transcript. A model-generated summary
 *     is not reproducible even at temperature 0 across model versions.
 *   - **Cannot hallucinate.** Every character in the output appeared in the
 *     input. A generative summariser can invent a decision that was never made,
 *     and that invention then becomes context for every later turn.
 *   - **Free and instant.** No quota, no latency, nothing in the critical path.
 *
 * The cost is a worse compression ratio (~3:1 rather than ~10:1) and clumsier
 * prose. `SummarizerPort` exists so a model-backed implementation can replace
 * this without touching the pipeline.
 *
 * Pure: no clock, no I/O, no randomness.
 */

/**
 * Signals that a line carries decisions, constraints, or named entities — the
 * things a summary MUST preserve. Ordered roughly by how much they predict
 * that a line matters later in a conversation.
 */
const SALIENT = [
  /\b(?:must|should|never|always|require[sd]?|need(?:s|ed)?)\b/i, // constraints
  /\b(?:decided|chose|chosen|agreed|conclusion|instead|because)\b/i, // decisions
  /\b(?:error|fail(?:s|ed|ure)?|bug|broken|issue)\b/i, // problems
  /\b(?:TODO|FIXME|next step|remaining)\b/i, // open threads
  /[`'"][^`'"]{2,}[`'"]/, // quoted identifiers
  /\b\w+\.(?:js|ts|py|json|md|sql|yaml|yml|go|rs|java)\b/, // file paths
  /\bhttps?:\/\/\S+/, // URLs
  /\bv?\d+\.\d+(?:\.\d+)?\b/, // versions and numbers
];

/**
 * Conversational scaffolding a summary MUST drop: it carries no information
 * and is the bulk of what makes raw history expensive.
 */
const FILLER =
  /^(?:sure|certainly|of course|happy to|great question|thanks?|thank you|you'?re welcome|no problem|got it|understood|okay|ok|yes|no)\b[\s,.!—-]*/i;

export class ExtractiveSummarizer {
  /**
   * @param {object} [options]
   * @param {number} [options.maxLinesPerMessage] salient lines kept per message
   * @param {number} [options.maxChars] hard ceiling on the produced summary
   */
  constructor({ maxLinesPerMessage = 3, maxChars = 2000 } = {}) {
    this.maxLinesPerMessage = maxLinesPerMessage;
    this.maxChars = maxChars;
  }

  /**
   * Compress a span of messages into one summary message.
   *
   * @param {object[]} messages
   * @param {{fromIndex: number, toIndex: number}} span
   * @returns {{role: string, content: string, isSummary: true, coversFromIndex, coversToIndex}}
   */
  summarize(messages, { fromIndex, toIndex } = {}) {
    const lines = [];

    for (const message of messages) {
      const extracted = this.#extract(message);
      if (extracted.length === 0) continue;
      const speaker = message.role === "user" ? "User" : "Assistant";
      for (const line of extracted) lines.push(`${speaker}: ${line}`);
    }

    // Labelled as a summary in the prompt so the model treats it as secondary
    // evidence rather than as something the user just said.
    const body = lines.length
      ? lines.join("\n").slice(0, this.maxChars)
      : "(no salient content in the compressed span)";

    return {
      role: "system",
      content: `[Summary of earlier conversation]\n${body}`,
      isSummary: true,
      coversFromIndex: fromIndex,
      coversToIndex: toIndex,
    };
  }

  /**
   * Pull the salient lines out of one message.
   *
   * Scores each line by how many salience signals it matches, then keeps the
   * top few **in original order** — reordering would destroy the causal
   * structure that makes a summary readable.
   */
  #extract(message) {
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content.trim()) return [];

    const scored = content
      .split(/\r?\n/)
      .map((line) => line.replace(FILLER, "").trim())
      .filter((line) => line.length > 0)
      .map((line, index) => ({
        line,
        index,
        score: SALIENT.reduce((total, pattern) => total + (pattern.test(line) ? 1 : 0), 0),
      }));

    if (scored.length === 0) return [];

    const salient = scored.filter((entry) => entry.score > 0);
    // A message with no explicit signals still contributed something; its first
    // line is the topic sentence and is better than dropping it entirely.
    const chosen = salient.length > 0 ? salient : [scored[0]];

    return chosen
      // Stable: sort by score descending, then by original position, so ties
      // never depend on the engine's sort implementation.
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, this.maxLinesPerMessage)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.line);
  }
}

/**
 * The port a model-backed summariser will implement.
 *
 * Declared now so the pipeline depends on the interface rather than on the
 * extractive implementation, and swapping it later is a composition-root change
 * (docs/backend/06-context-engine.md#summary-requirements).
 *
 * @typedef {object} SummarizerPort
 * @property {(messages: object[], span: {fromIndex: number, toIndex: number}) => object} summarize
 */
