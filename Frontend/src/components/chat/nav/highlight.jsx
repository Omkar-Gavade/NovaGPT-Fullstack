import { Fragment } from "react";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Render `text` with every case-insensitive occurrence of `query` marked. */
export function Highlight({ text = "", query = "" }) {
  if (!query) return text;
  const parts = String(text).split(new RegExp(`(${escape(query)})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded-[3px] bg-accent/30 text-primary">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );
}
