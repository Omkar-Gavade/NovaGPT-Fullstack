import { randomUUID } from "node:crypto";
import { Thread } from "../../domain/conversation/Thread.js";
import { AppError, ErrorKind } from "../../domain/errors/index.js";

/**
 * Conversation lifecycle: list, read, rename, pin, archive, share, delete.
 *
 * Every method is owner-scoped through the repository. The scoping lives in the
 * query rather than in a check here, so a method added later without a check
 * returns nothing instead of someone else's conversation
 * (docs/backend/10-security.md#authorization).
 *
 * Thin by design — the rules live in the `Thread` aggregate. This class exists
 * to sequence load → transform → save, and to turn a missing thread into a 404
 * exactly once instead of at ten call sites.
 */
export class ThreadService {
  constructor({ threads, clock, logger }) {
    this.threads = threads;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "threads" }) ?? logger;
  }

  async list({ ownerId = null, archived = false, limit = 20, cursor = null, query = null } = {}) {
    return this.threads.list({ ownerId, archived, limit, cursor, query });
  }

  async get(threadId, ownerId = null) {
    return this.#load(threadId, ownerId);
  }

  /** Public, read-only view. Deliberately unscoped — a share link is the grant. */
  async getShared(shareId) {
    const thread = await this.threads.findByShareId(shareId);
    if (!thread) throw new AppError("Shared conversation not found.", ErrorKind.NOT_FOUND);
    return { title: thread.title, messages: thread.messages, createdAt: thread.createdAt };
  }

  async rename(threadId, title, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    return this.threads.save(thread.rename(title));
  }

  async setArchived(threadId, archived, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    return this.threads.save(thread.setArchived(archived));
  }

  async setPinned(threadId, pinned, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    return this.threads.save(thread.setPinnedThread(pinned));
  }

  async updateSettings(threadId, settings, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    const saved = await this.threads.save(thread.updateSettings(settings));
    return saved.settings;
  }

  async pinMessage(threadId, messageId, pinned, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    return this.threads.save(thread.setPinned(messageId, pinned));
  }

  /**
   * Create or return the existing share link.
   *
   * Idempotent: a double-click must not mint a second link the user cannot see
   * and therefore cannot revoke (docs/backend/09-api-design.md#conversations).
   */
  async share(threadId, ownerId = null, publicUrl = null) {
    const thread = await this.#load(threadId, ownerId);
    const shareId = thread.shareId ?? randomUUID().replace(/-/g, "").slice(0, 22);
    if (!thread.shareId) await this.threads.save(thread.withShareId(shareId));
    return { shareId, url: publicUrl ? `${publicUrl}/share/${shareId}` : `/share/${shareId}` };
  }

  async unshare(threadId, ownerId = null) {
    const thread = await this.#load(threadId, ownerId);
    await this.threads.save(thread.withShareId(null));
    return true;
  }

  /**
   * Soft delete.
   *
   * A 30-day undo window costs almost nothing and converts an unrecoverable
   * support request into an inconvenience. The purge is real and scheduled.
   */
  async delete(threadId, ownerId = null) {
    const deleted = await this.threads.softDelete(threadId, ownerId);
    if (!deleted) throw new AppError("Conversation not found.", ErrorKind.NOT_FOUND);
    this.logger?.info("thread.deleted", { threadId });
    return true;
  }

  /** Copy messages and settings under a fresh id, unshared. */
  async duplicate(threadId, ownerId = null) {
    const source = await this.#load(threadId, ownerId);
    const copy = new Thread({
      ...source.toJSON(),
      id: randomUUID(),
      title: `${source.title} (copy)`,
      // A copy must not inherit the original's share link, or revoking one
      // would silently revoke the other.
      shareId: null,
      createdAt: new Date(this.clock.now()).toISOString(),
      updatedAt: new Date(this.clock.now()).toISOString(),
    });
    return this.threads.save(copy);
  }

  async #load(threadId, ownerId) {
    const thread = await this.threads.findById(threadId, ownerId);
    if (!thread) throw new AppError("Conversation not found.", ErrorKind.NOT_FOUND);
    return thread;
  }
}
