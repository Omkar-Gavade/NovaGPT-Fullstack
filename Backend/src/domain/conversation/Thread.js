import { Message, Role, FinishReason } from "./Message.js";
import { ConversationSettings } from "./ConversationSettings.js";
import { AppError, ErrorKind } from "../errors/index.js";

/**
 * A conversation.
 *
 * The aggregate root: messages are only ever reached through their thread, and
 * every mutation goes through a method here rather than through the array. That
 * is what keeps the invariants enforceable — an orphaned assistant reply or a
 * non-chronological history is unrepresentable rather than merely discouraged.
 *
 * Methods return a **new** thread rather than mutating. Two concurrent sends on
 * one thread are a real scenario (two browser tabs), and a mutable aggregate
 * makes the resulting interleaving impossible to reason about. The repository
 * resolves the write conflict; the domain stays a pure transformation.
 */
export class Thread {
  constructor(raw = {}) {
    if (!raw.id) throw new TypeError("A thread needs an id");

    this.id = raw.id;
    this.userId = raw.userId ?? null;
    // Reserved for multi-tenancy so adding it later is additive rather than a
    // schema migration (docs/backend/08-storage.md).
    this.tenantId = raw.tenantId ?? null;

    this.title = raw.title ?? "New chat";
    this.messages = Object.freeze(
      (raw.messages ?? []).map((m) => (m instanceof Message ? m : new Message(m)))
    );
    this.settings =
      raw.settings instanceof ConversationSettings
        ? raw.settings
        : new ConversationSettings(raw.settings ?? {});

    this.pinned = raw.pinned === true;
    this.archived = raw.archived === true;
    this.shareId = raw.shareId ?? null;

    // Denormalised: the sidebar renders these, and computing them from the
    // embedded array would mean loading every message of every thread.
    this.messageCount = raw.messageCount ?? this.messages.length;
    this.totalTokens = raw.totalTokens ?? 0;

    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    this.updatedAt = raw.updatedAt ? new Date(raw.updatedAt) : this.createdAt;
    this.lastMessageAt = raw.lastMessageAt ? new Date(raw.lastMessageAt) : null;
    this.deletedAt = raw.deletedAt ? new Date(raw.deletedAt) : null;

    // Per-conversation calibration survives a restart, so the estimator does
    // not relearn this conversation's token density from scratch each time.
    this.tokenCorrectionFactor = Number.isFinite(raw.tokenCorrectionFactor)
      ? raw.tokenCorrectionFactor
      : 1;

    Object.freeze(this);
  }

  /* ------------------------------- queries ------------------------------ */

  get isEmpty() {
    return this.messages.length === 0;
  }

  get lastMessage() {
    return this.messages.at(-1) ?? null;
  }

  get lastAssistantMessage() {
    return [...this.messages].reverse().find((m) => m.isAssistant) ?? null;
  }

  /** History excluding the newest user turn — what the context engine assembles. */
  historyBefore(messageId) {
    const index = this.messages.findIndex((m) => m.id === messageId);
    return index === -1 ? [...this.messages] : this.messages.slice(0, index);
  }

  findMessage(messageId) {
    return this.messages.find((m) => m.id === messageId) ?? null;
  }

  /* ------------------------------ mutations ----------------------------- */

  /**
   * Append a user turn.
   *
   * The title is derived from the first user message. Doing it here rather than
   * at the API boundary means every entry point produces the same behaviour,
   * including ones that do not exist yet.
   */
  appendUserMessage(message) {
    const next = message instanceof Message ? message : new Message({ ...message, role: Role.USER });
    return this.#append(next, {
      title: this.isEmpty ? deriveTitle(next) : this.title,
    });
  }

  appendAssistantMessage(message) {
    const next =
      message instanceof Message ? message : new Message({ ...message, role: Role.ASSISTANT });
    return this.#append(next, {
      totalTokens: this.totalTokens + (next.usage?.totalTokens ?? next.tokenEstimate ?? 0),
    });
  }

  /**
   * Discard a turn and everything after it.
   *
   * Regeneration works by rewinding: the conversation must look as it did
   * *before* the message being regenerated, or the model sees its own previous
   * answer as context and the regeneration is not independent.
   */
  truncateFrom(messageId) {
    const index = this.messages.findIndex((m) => m.id === messageId);
    if (index === -1) {
      throw new AppError("That message is not part of this conversation.", ErrorKind.NOT_FOUND, {
        details: { messageId },
      });
    }
    return new Thread({
      ...this.toJSON(),
      messages: this.messages.slice(0, index).map((m) => m.toJSON()),
      messageCount: index,
      updatedAt: new Date(),
    });
  }

  /**
   * Replace an assistant turn's content in place.
   *
   * Used by `continue`, which extends a length-truncated reply rather than
   * appending a second assistant turn — two consecutive assistant messages are
   * malformed dialogue and models handle them badly.
   */
  replaceMessage(messageId, changes) {
    const index = this.messages.findIndex((m) => m.id === messageId);
    if (index === -1) {
      throw new AppError("That message is not part of this conversation.", ErrorKind.NOT_FOUND, {
        details: { messageId },
      });
    }
    const messages = [...this.messages];
    messages[index] = messages[index].with(changes);
    return new Thread({
      ...this.toJSON(),
      messages: messages.map((m) => m.toJSON()),
      updatedAt: new Date(),
    });
  }

  setPinned(messageId, pinned) {
    return this.replaceMessage(messageId, { pinned: pinned === true });
  }

  rename(title) {
    const trimmed = String(title ?? "").trim();
    if (!trimmed) {
      throw new AppError("A title cannot be empty.", ErrorKind.VALIDATION, { field: "title" });
    }
    return new Thread({ ...this.toJSON(), title: trimmed.slice(0, 120), updatedAt: new Date() });
  }

  updateSettings(changes) {
    return new Thread({
      ...this.toJSON(),
      settings: this.settings.merge(changes).toJSON(),
      updatedAt: new Date(),
    });
  }

  setArchived(archived) {
    return new Thread({ ...this.toJSON(), archived: archived === true, updatedAt: new Date() });
  }

  setPinnedThread(pinned) {
    return new Thread({ ...this.toJSON(), pinned: pinned === true, updatedAt: new Date() });
  }

  /**
   * Soft delete.
   *
   * A 30-day window turns an accidental deletion from a permanent, unsatisfiable
   * support request into an inconvenience. The purge is real and scheduled — a
   * "delete" that never deletes is a privacy violation dressed as a feature
   * (docs/backend/08-storage.md#retention-and-ttl).
   */
  markDeleted(now = new Date()) {
    return new Thread({ ...this.toJSON(), deletedAt: now, updatedAt: now });
  }

  withShareId(shareId) {
    return new Thread({ ...this.toJSON(), shareId, updatedAt: new Date() });
  }

  withCorrectionFactor(factor) {
    return new Thread({ ...this.toJSON(), tokenCorrectionFactor: factor });
  }

  #append(message, extra = {}) {
    const now = new Date();
    return new Thread({
      ...this.toJSON(),
      messages: [...this.messages, message].map((m) => m.toJSON()),
      messageCount: this.messages.length + 1,
      updatedAt: now,
      lastMessageAt: now,
      ...extra,
    });
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      tenantId: this.tenantId,
      title: this.title,
      messages: this.messages.map((m) => m.toJSON()),
      settings: this.settings.toJSON(),
      pinned: this.pinned,
      archived: this.archived,
      shareId: this.shareId,
      messageCount: this.messageCount,
      totalTokens: this.totalTokens,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      lastMessageAt: this.lastMessageAt?.toISOString() ?? null,
      deletedAt: this.deletedAt?.toISOString() ?? null,
      tokenCorrectionFactor: this.tokenCorrectionFactor,
    };
  }
}

/** First line of the first user message, bounded. */
function deriveTitle(message) {
  const text = typeof message.content === "string" ? message.content : "";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return firstLine.trim().slice(0, 80) || "New chat";
}

export { Role, FinishReason, Message, ConversationSettings };
