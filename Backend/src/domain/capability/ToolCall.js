/**
 * One normalised tool call.
 *
 * The acceptance criterion is that tool-call responses look **identical**
 * across every tool-capable provider, and the two dialects in this fleet do not
 * agree on the single most important field:
 *
 *   - The OpenAI dialect returns `arguments` as a **JSON string**.
 *   - Gemini returns `args` as an already-parsed **object**.
 *
 * A client handed one shape from one provider and the other after a failover
 * has to sniff the type on every call — which means the failover is visible,
 * which is the thing the whole abstraction exists to prevent.
 *
 * Normalised to the **parsed object**, because that is what a caller wants and
 * because a string is trivially recoverable from it while the reverse can fail.
 * The raw form is kept beside it for anything that needs to echo the call back
 * to the provider verbatim.
 *
 * **This is a declaration of intent, never a result.** Executing a tool is a
 * trust and sandboxing problem of a different kind and is explicitly out of
 * scope (docs/backend/14-roadmap.md).
 */
export class ToolCall {
  constructor({ id, name, args, raw = null }) {
    this.id = id ?? null;
    this.name = name ?? null;
    this.arguments = args ?? {};
    // What the provider actually sent. Preserved so a client echoing the call
    // back is byte-identical, and so a malformed payload is still inspectable.
    this.raw = raw;
    Object.freeze(this);
  }

  /**
   * From the OpenAI dialect, where arguments arrive as a JSON string.
   *
   * A model that emits invalid JSON in that string is common enough to matter;
   * it yields empty arguments and keeps the raw text rather than throwing,
   * because the *call* is still information even when its payload is not.
   */
  static fromOpenAI(call) {
    const raw = call?.function?.arguments ?? "";
    let args = {};
    try {
      args = raw ? JSON.parse(raw) : {};
    } catch {
      args = {};
    }
    return new ToolCall({ id: call?.id, name: call?.function?.name, args, raw });
  }

  /** From Gemini, where arguments are already an object. */
  static fromGemini(call, index = 0) {
    return new ToolCall({
      // Gemini does not issue call ids. One is synthesised so a client can
      // correlate a result back to its call, which is the only thing the id is
      // for — and its absence would otherwise be a per-provider difference.
      id: call?.id ?? `call_${index}`,
      name: call?.name,
      args: call?.args ?? {},
      raw: JSON.stringify(call?.args ?? {}),
    });
  }

  toJSON() {
    return { id: this.id, name: this.name, arguments: this.arguments, raw: this.raw };
  }
}
