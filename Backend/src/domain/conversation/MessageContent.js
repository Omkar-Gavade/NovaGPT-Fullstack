/**
 * The canonical shape of multimodal message content.
 *
 * One representation, chosen once, that every adapter maps *from*. The
 * alternative — each adapter reading raw attachments and inventing its own
 * shape — puts the same conversion in nine places and guarantees they drift.
 *
 * The canonical form is the **OpenAI dialect's**, because six of the nine
 * adapters speak it natively and would otherwise translate to and from an
 * invented intermediate for no benefit. Gemini maps it in `toParts()`; that is
 * the adapter's job, and precisely what an adapter is for
 * (docs/backend/03-provider-system.md#adapter-pattern).
 *
 * ```js
 * [
 *   { type: "text", text: "what is in this picture?" },
 *   { type: "image_url", image_url: { url: "data:image/png;base64,…" } },
 *   { type: "file", file: { mime: "application/pdf", data: "…" } },
 * ]
 * ```
 *
 * `file` is ours rather than OpenAI's, because the dialect has no standard
 * part for native PDF input. Adapters that cannot take a PDF never see one:
 * routing filters on the `pdf` capability first, so the part only reaches a
 * provider that declared it can read one.
 */

/**
 * Build content from text plus already-ingested attachments.
 *
 * Attachments arrive **validated** — sniffed, size-capped, base64 — because
 * ingestion happens before this and never after. Building content from
 * unvalidated input would put the SSRF boundary downstream of the thing it is
 * supposed to guard (docs/backend/10-security.md#input-validation).
 *
 * @param {string} text
 * @param {{kind: string, mime: string, base64: string}[]} attachments
 * @returns {string|object[]} plain text when there is nothing else, so the
 *   overwhelmingly common case stays a string and every existing code path
 *   that assumes one keeps working
 */
export function buildContent(text, attachments = []) {
  if (!attachments.length) return text;

  const parts = [];
  // Text first. Several providers weight the leading part more heavily, and a
  // question that arrives after four images reads as an afterthought.
  if (text) parts.push({ type: "text", text });

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mime};base64,${attachment.base64}` },
      });
    } else {
      parts.push({ type: "file", file: { mime: attachment.mime, data: attachment.base64 } });
    }
  }

  return parts;
}

/** The text of a message, whatever shape its content is in. */
export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part) => part?.type === "text" || typeof part === "string")
    .map((part) => (typeof part === "string" ? part : part.text))
    .join("\n");
}

/** True when this content carries anything that is not text. */
export function isMultimodal(content) {
  return Array.isArray(content) && content.some((part) => part?.type && part.type !== "text");
}

/**
 * What capabilities this content requires of a model.
 *
 * Derived from the content itself rather than from what the client claimed, so
 * a request cannot be routed to a text-only model by mislabelling its own
 * attachments.
 */
export function requirementsOfContent(content) {
  if (!Array.isArray(content)) return {};
  const required = {};
  for (const part of content) {
    if (part?.type === "image_url") required.vision = true;
    if (part?.type === "file") required.pdf = true;
  }
  return required;
}

/**
 * Strip binary payloads, keeping the shape.
 *
 * Used for persistence and for anything that logs a message. A stored thread
 * carrying four base64 images is a document that grows past the BSON limit and
 * a log line nobody can read — and re-sending the bytes on the next turn would
 * re-upload them to the provider on every message
 * (docs/backend/08-storage.md).
 */
export function withoutPayloads(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "image_url") {
      return { type: "image_url", image_url: { url: "[image]" }, elided: true };
    }
    if (part?.type === "file") {
      return { type: "file", file: { mime: part.file?.mime ?? null }, elided: true };
    }
    return part;
  });
}
