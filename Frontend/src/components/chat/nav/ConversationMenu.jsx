import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Pin, PinOff, Pencil, Copy, Archive, ArchiveRestore, Share2, Trash2 } from "lucide-react";
import { useChat } from "../../../context/ChatContext";

/**
 * Conversation context menu — real actions, no stubs. Pin/Duplicate/Archive/
 * Share/Delete run through ChatContext; Rename is delegated to the parent so it
 * can drive inline editing. Keyboard: Esc closes; arrow keys move.
 */
export default function ConversationMenu({ thread, onClose, onRename }) {
  const { pinThread, archiveThread, duplicateThread, shareThread, deleteThread } = useChat();
  const reduce = useReducedMotion();
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.querySelector("[role=menuitem]")?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      const items = [...(ref.current?.querySelectorAll("[role=menuitem]") || [])];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (fn) => (e) => {
    e.stopPropagation();
    fn();
    onClose();
  };

  const ITEMS = [
    thread.pinned
      ? { icon: PinOff, label: "Unpin", act: () => pinThread(thread.threadId, false) }
      : { icon: Pin, label: "Pin", act: () => pinThread(thread.threadId, true) },
    { icon: Pencil, label: "Rename", act: () => onRename(thread) },
    { icon: Copy, label: "Duplicate", act: () => duplicateThread(thread.threadId) },
    thread.archived
      ? { icon: ArchiveRestore, label: "Unarchive", act: () => archiveThread(thread.threadId, false) }
      : { icon: Archive, label: "Archive", act: () => archiveThread(thread.threadId, true) },
    { icon: Share2, label: "Share", act: () => shareThread(thread.threadId) },
    { divider: true },
    {
      icon: Trash2,
      label: "Delete",
      danger: true,
      act: () => {
        if (window.confirm("Delete this chat?")) deleteThread(thread.threadId);
      },
    },
  ];

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Conversation options"
      onClick={(e) => e.stopPropagation()}
      initial={reduce ? false : { opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
      className="absolute right-1 top-9 z-40 w-44 rounded-xl bg-elevated p-1.5 shadow-xl ring-1 ring-line"
    >
      {ITEMS.map((it, i) =>
        it.divider ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={it.label}
            role="menuitem"
            onClick={run(it.act)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
              transition-colors focus:outline-none
              ${it.danger ? "text-danger hover:bg-danger/15" : "text-primary hover:bg-hover"}`}
          >
            <it.icon size={15} /> {it.label}
          </button>
        )
      )}
    </motion.div>
  );
}
