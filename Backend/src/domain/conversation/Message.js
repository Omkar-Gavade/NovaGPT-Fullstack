/**
 * One turn in a conversation.
 *
 * Immutable once created. A message is a historical fact — it was said, at a
 * time, by a participant — and editing one retroactively would make the
 * conversation a model saw unreconstructable, which is the same property the
 * context engine's determinism depends on.
 *
 * Assistant messages record **which model produced them**. With failover,
 * different turns in one conversation come from different providers, and
 * without that record a tone or quality shift is inexplicable to the user and
 * undebuggable for us (docs/backend/06-context-engine.md#the-data-model).
 */

export const Role = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
});

/** Where an assistant turn stopped, and whether it can be continued. */
export const FinishReason = Object.freeze({
  STOP: "stop",
  LENGTH: "length",
  CANCELLED: "cancelled",
  ERROR: "error",
});

export class Message {
  /**
   * @param {object} raw
   * @param {string} raw.id
   * @param {string} raw.role
   * @param {string|object[]} raw.content
   * @param {string} [raw.model]     which model produced an assistant turn
   * @param {string} [raw.provider]
   * @param {boolean} [raw.pinned]
   * @param {number} [raw.tokenEstimate] cached at write time
   * @param {object} [raw.usage]     provider-reported counts
   * @param {string} [raw.finishReason]
   * @param {object} [raw.attachments]
   * @param {Date|string} [raw.createdAt]
   */
  constructor(raw = {}) {
    if (!Object.values(Role).includes(raw.role)) {
      throw new TypeError(`Unknown message role "${raw.role}"`);
    }
    if (raw.content === undefined || raw.content === null) {
      throw new TypeError("A message needs content");
    }

    this.id = raw.id;
    this.role = raw.role;
    this.content = raw.content;

    // Null for user turns; set for assistant turns so the UI can show which
    // model answered and a bad answer can be traced to its source.
    this.model = raw.model ?? null;
    this.provider = raw.provider ?? null;

    this.pinned = raw.pinned === true;
    this.isSummary = raw.isSummary === true;

    // Computed once at write time. The count for a stored message never
    // changes, so recomputing it on every assembly turns an O(1) cost into
    // O(n) on the hottest path (docs/backend/06-context-engine.md).
    this.tokenEstimate = Number.isFinite(raw.tokenEstimate) ? raw.tokenEstimate : null;

    this.usage = raw.usage ?? null;
    this.finishReason = raw.finishReason ?? null;
    this.attachments = Object.freeze([...(raw.attachments ?? [])]);

    // Diagnostics captured at generation time. Summaries only — the full
    // objects belong in logs, not in every stored message.
    this.contextReport = raw.contextReport ?? null;
    this.routingDecision = raw.routingDecision ?? null;

    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    this.error = raw.error ?? null;

    Object.freeze(this);
  }

  get isUser() {
    return this.role === Role.USER;
  }

  get isAssistant() {
    return this.role === Role.ASSISTANT;
  }

  /**
   * Whether this turn can be continued.
   *
   * Only a length-truncated assistant turn can: a completed one has nothing
   * left to say, and continuing a cancelled or errored turn would extend
   * output the user never accepted.
   */
  get isContinuable() {
    return this.isAssistant && this.finishReason === FinishReason.LENGTH;
  }

  get text() {
    return typeof this.content === "string" ? this.content : JSON.stringify(this.content);
  }

  /** A copy with fields replaced. The original is untouched. */
  with(changes = {}) {
    return new Message({ ...this.toJSON(), ...changes });
  }

  toJSON() {
    return {
      id: this.id,
      role: this.role,
      content: this.content,
      model: this.model,
      provider: this.provider,
      pinned: this.pinned,
      isSummary: this.isSummary,
      tokenEstimate: this.tokenEstimate,
      usage: this.usage,
      finishReason: this.finishReason,
      attachments: [...this.attachments],
      contextReport: this.contextReport,
      routingDecision: this.routingDecision,
      createdAt: this.createdAt.toISOString(),
      error: this.error,
    };
  }
}
