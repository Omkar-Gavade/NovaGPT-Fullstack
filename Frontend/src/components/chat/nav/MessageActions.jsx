import { useState } from "react";
import { Copy, Check, ThumbsUp, ThumbsDown, RefreshCw, Pencil, ArrowRightToLine } from "lucide-react";

/**
 * Reusable message action row (ChatGPT parity). Presentational — every action
 * is passed in, so the same component serves user and assistant turns.
 *
 * For user turns: Copy, Edit.
 * For assistant turns: Copy, Thumbs up/down, Regenerate, Continue.
 */
export default function MessageActions({ role, text, onEdit, onRegenerate, onContinue, modelTag }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState(null);

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const Btn = ({ icon: Icon, label, onClick, pressed, fill }) => (
    <button className="cg-action" onClick={onClick} aria-label={label} aria-pressed={pressed}>
      <Icon size={16} fill={fill ? "currentColor" : "none"} />
    </button>
  );

  return (
    <div className={`cg-actions ${role === "user" ? "justify-end" : ""}`}>
      <Btn icon={copied ? Check : Copy} label="Copy" onClick={copy} />

      {role === "user" && onEdit && <Btn icon={Pencil} label="Edit message" onClick={onEdit} />}

      {role === "assistant" && (
        <>
          <Btn icon={ThumbsUp} label="Good response" pressed={vote === "up"} fill={vote === "up"} onClick={() => setVote(vote === "up" ? null : "up")} />
          <Btn icon={ThumbsDown} label="Bad response" pressed={vote === "down"} fill={vote === "down"} onClick={() => setVote(vote === "down" ? null : "down")} />
          {onRegenerate && <Btn icon={RefreshCw} label="Regenerate response" onClick={onRegenerate} />}
          {onContinue && <Btn icon={ArrowRightToLine} label="Continue generating" onClick={onContinue} />}
          {modelTag && <span className="cg-model-tag">{modelTag}</span>}
        </>
      )}
    </div>
  );
}
