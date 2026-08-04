/**
 * Content injected into a prompt that did not come from this conversation.
 *
 * Four kinds, in a **fixed order, most stable first**
 * (docs/backend/06-context-engine.md#injection-order-and-why-it-is-fixed):
 *
 *     [ system prompt ]                 never changes
 *     [ user profile / long-term memory ] changes rarely
 *     [ retrieved documents ]           changes per query
 *     [ conversation summary ]          changes per compression
 *     [ recent messages ]               changes every turn
 *     [ newest user message ]
 *
 * **Why the order matters practically:** it is what makes prompt caching viable.
 * Providers that cache prompt prefixes can only reuse a cache when the prefix is
 * byte-identical, so putting volatile content early invalidates the cache on
 * every turn and forfeits a large latency and cost saving. The ordering is fixed
 * now, before caching exists, because retrofitting it later would change every
 * prompt the system produces.
 *
 * Phase 4 populates the system prompt only. Profile, long-term memory and
 * retrieval are out of scope, so their slots resolve to nothing — but the slots
 * exist, which is what makes adding them an insertion rather than a rewrite.
 */

export const MemoryKind = {
  SYSTEM_PROMPT: "systemPrompt",
  PROFILE: "profile",
  LONG_TERM: "longTerm",
  DOCUMENTS: "documents",
};

/** The order slots are assembled in. Never reordered at runtime. */
const INJECTION_ORDER = [
  MemoryKind.SYSTEM_PROMPT,
  MemoryKind.PROFILE,
  MemoryKind.LONG_TERM,
  MemoryKind.DOCUMENTS,
];

export class MemoryInjection {
  /**
   * @param {object} deps
   * @param {import("./TokenEstimator.js").TokenEstimator} deps.estimator
   */
  constructor({ estimator }) {
    this.estimator = estimator;
  }

  /**
   * Build the leading messages.
   *
   * @param {object} input
   * @param {string} [input.systemPrompt]
   * @param {string} [input.profile]
   * @param {string[]} [input.longTerm]
   * @param {object[]} [input.documents]  `{ title, content }`
   * @param {import("./TokenBudget.js").TokenBudget} input.budget
   * @param {import("./ContextReport.js").ContextReport} input.report
   * @returns {{messages: object[], tokens: number}}
   */
  build({ systemPrompt, profile, longTerm = [], documents = [], budget, report }) {
    const slots = {
      [MemoryKind.SYSTEM_PROMPT]: systemPrompt?.trim()
        ? [{ role: "system", content: systemPrompt.trim(), isSystemPrompt: true }]
        : [],
      [MemoryKind.PROFILE]: profile?.trim()
        ? [{ role: "system", content: `[About the user]\n${profile.trim()}`, isMemory: true }]
        : [],
      [MemoryKind.LONG_TERM]: longTerm.length
        ? [{ role: "system", content: `[Remembered]\n${longTerm.join("\n")}`, isMemory: true }]
        : [],
      [MemoryKind.DOCUMENTS]: documents.length
        ? [
            {
              role: "system",
              content: `[Retrieved context]\n${documents
                .map((d) => `— ${d.title ?? "document"}: ${d.content}`)
                .join("\n\n")}`,
              isDocument: true,
            },
          ]
        : [],
    };

    const messages = [];
    let memoryTokens = 0;

    for (const kind of INJECTION_ORDER) {
      for (const message of slots[kind]) {
        const tokens = this.estimator.estimateMessage(message);

        // The system prompt is never budgeted away — it carries behavioural
        // instructions, and dropping it changes the model's persona mid-
        // conversation. It is accounted for separately in TokenBudget.
        if (kind === MemoryKind.SYSTEM_PROMPT) {
          messages.push(message);
          report.included.systemPrompt += tokens;
          continue;
        }

        // Everything else is capped. Memory that crowds out the conversation
        // makes the model answer from general knowledge instead of from what
        // the user just said.
        if (memoryTokens + tokens > budget.memoryBudget) {
          report.warn(
            `${kind} was omitted: injected memory would exceed ${budget.memoryBudget} tokens (25% of the prompt budget)`
          );
          continue;
        }

        messages.push(message);
        memoryTokens += tokens;
        if (kind === MemoryKind.DOCUMENTS) report.included.documents += tokens;
        else report.included.memory += tokens;
      }
    }

    return { messages, tokens: report.included.systemPrompt + memoryTokens };
  }
}

/**
 * The retrieval port, declared and deliberately unimplemented.
 *
 * The pipeline stage, the budget allocation and the report field all exist from
 * day one with nothing behind them. Adding real retrieval later means writing
 * one adapter and changing one line in the composition root; retrofitting a
 * stage into assembly logic never designed for it would mean rewriting the
 * assembly and re-testing every trimming path
 * (docs/backend/06-context-engine.md#future-rag-integration).
 *
 * @typedef {object} RetrievalPort
 * @property {(query: string, limit: number) => Promise<Array<{title: string, content: string}>>} retrieve
 */

/** Phase 4's implementation: there is no corpus, so there is nothing to retrieve. */
export class NullRetriever {
  async retrieve() {
    return [];
  }
}
