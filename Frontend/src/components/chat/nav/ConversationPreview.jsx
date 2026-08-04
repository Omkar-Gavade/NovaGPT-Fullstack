import { motion, useReducedMotion } from "motion/react";
import { formatTime, formatThreadDate, truncate } from "../../../utils/format";

function Line({ m }) {
  const isUser = m.role === "user";
  return (
    <div className="flex gap-2">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${isUser ? "bg-secondary" : "bg-accent"}`}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-secondary">{isUser ? "You" : "NovaGPT"}</span>
          <span className="text-[10px] text-tertiary">{formatTime(m.timestamp)}</span>
        </div>
        <p className="text-[12.5px] leading-snug text-secondary">{truncate(m.content, 140)}</p>
      </div>
    </div>
  );
}

/**
 * Floating peek card shown beside the sidebar on row hover. Real data only —
 * first + latest messages with role indicators and timestamps.
 */
export default function ConversationPreview({ thread, top }) {
  const reduce = useReducedMotion();
  const msgs = thread.messages || [];
  const first = msgs[0];
  const latest = msgs.slice(-2);

  return (
    <motion.div
      role="dialog"
      aria-label={`Preview of ${thread.title}`}
      initial={reduce ? false : { opacity: 0, scale: 0.97, x: -6 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.97, x: -6 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      style={{ top: Math.max(12, Math.min(top, window.innerHeight - 240)) }}
      className="pointer-events-none fixed left-[268px] z-50 w-72 rounded-2xl bg-elevated p-3.5 shadow-2xl ring-1 ring-line"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="truncate text-sm font-semibold text-primary">{thread.title}</h4>
        <span className="shrink-0 text-[11px] text-tertiary">{formatThreadDate(thread.timestamp)}</span>
      </div>

      {msgs.length === 0 ? (
        <p className="text-[12.5px] text-tertiary">No messages yet</p>
      ) : (
        <div className="space-y-2.5">
          {first && <Line m={first} />}
          {msgs.length > 3 && <div className="pl-3.5 text-[11px] text-tertiary">···</div>}
          {latest.filter((m) => m !== first).map((m, i) => (
            <Line key={i} m={m} />
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-line pt-2 text-[11px] text-tertiary">
        {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
      </div>
    </motion.div>
  );
}
