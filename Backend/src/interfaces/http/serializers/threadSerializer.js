/**
 * Domain → wire.
 *
 * Built field by field, never by spreading. A serialiser that spreads an
 * internal object eventually ships something it should not — the exact shape of
 * the leak the threat model describes
 * (docs/backend/10-security.md#structural-defences-against-leakage-t1).
 */

export function serializeMessage(message) {
  if (!message) return null;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    model: message.model,
    provider: message.provider,
    pinned: message.pinned,
    finishReason: message.finishReason,
    usage: message.usage,
    // Only present when the caller asked for structured output. Omitted rather
    // than null, so a client can distinguish "not requested" from "requested
    // and empty" without a second field.
    ...(message.structured ? { structured: message.structured } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    // Surfaced deliberately: this is the glass-box material that lets a user
    // see why a model was chosen and what context it received.
    context: message.contextReport,
    routing: message.routingDecision,
    createdAt: message.createdAt?.toISOString?.() ?? message.createdAt,
  };
}

export function serializeThread(thread, { includeMessages = true } = {}) {
  if (!thread) return null;
  return {
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned,
    archived: thread.archived,
    shareId: thread.shareId,
    messageCount: thread.messageCount,
    totalTokens: thread.totalTokens,
    settings: thread.settings.toJSON(),
    ...(includeMessages ? { messages: thread.messages.map(serializeMessage) } : {}),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
  };
}

/** List rows are already projections from the repository. */
export const serializeThreadSummary = (row) => ({
  id: row.id,
  title: row.title,
  pinned: row.pinned,
  archived: row.archived,
  messageCount: row.messageCount,
  shareId: row.shareId ?? null,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
  lastMessageAt: toIso(row.lastMessageAt),
});

const toIso = (value) =>
  value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
