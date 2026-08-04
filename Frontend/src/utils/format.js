/** Message id helper — local messages use `id`, persisted ones use `_id`. */
export const msgId = (m) => m?.id || m?._id;

/** Short clock time, e.g. "14:05". */
export function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative day label used in the thread list. */
export function formatThreadDate(value) {
  const d = new Date(value);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);

  if (diffDays <= 0) return formatTime(d);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function truncate(text = "", max = 60) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compact token/context formatting: 128000 -> "128K", 1000000 -> "1M". */
export function formatContext(tokens) {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * Rough token estimate (~4 chars per token). Good enough for a context-usage
 * meter; the exact number depends on each provider's tokenizer.
 */
export const estimateTokens = (text = "") => Math.ceil(text.length / 4);

export function conversationTokens(messages = []) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
}
