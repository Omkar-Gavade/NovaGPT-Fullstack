import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Search, MessageSquare, Cpu, Settings2, Command, Plus, CornerDownLeft } from "lucide-react";
import { useChat } from "../../../context/ChatContext";
import { Highlight } from "./highlight";
import { truncate } from "../../../utils/format";

/**
 * Global command palette (⌘K / Ctrl+K). Searches conversations, messages,
 * models, settings and commands; keyboard-driven; jumps on Enter.
 * Search logic is pure (useMemo) and separate from the presentation.
 */
export default function CommandPalette({ open, onClose }) {
  const { threads, catalog, selectThread, selectModel, updateSettings, startNewChat, settings } = useChat();
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ---- pure search: build a flat, grouped result set ---------------------
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const has = (s) => s?.toLowerCase().includes(q);
    const out = [];

    const commands = [
      { id: "cmd-new", type: "Command", label: "New chat", icon: Plus, run: () => startNewChat() },
    ];
    for (const c of commands) if (!q || has(c.label)) out.push(c);

    for (const t of threads) {
      if (!q || has(t.title)) {
        out.push({ id: `c-${t.threadId}`, type: "Conversation", label: t.title, icon: MessageSquare, run: () => selectThread(t.threadId) });
      }
    }

    if (q) {
      for (const t of threads) {
        for (const m of t.messages || []) {
          if (has(m.content)) {
            out.push({
              id: `m-${t.threadId}-${out.length}`,
              type: "Message",
              label: truncate(m.content, 80),
              sub: `${m.role === "user" ? "You" : "NovaGPT"} · ${t.title}`,
              icon: MessageSquare,
              run: () => selectThread(t.threadId),
            });
            break; // one hit per conversation keeps the list tidy
          }
        }
      }
    }

    for (const m of catalog) {
      if (m.configured && (!q || has(m.name) || has(m.providerName))) {
        out.push({ id: `mo-${m.id}`, type: "Model", label: m.name, sub: m.providerName, icon: Cpu, run: () => selectModel(m.id) });
      }
    }

    const settingsItems = [
      { key: "auto", label: "Failover: Auto switch" },
      { key: "ask", label: "Failover: Ask before switching" },
      { key: "never", label: "Failover: Never auto switch" },
    ];
    for (const s of settingsItems) {
      if (!q || has(s.label)) {
        out.push({
          id: `s-${s.key}`,
          type: "Setting",
          label: s.label,
          icon: Settings2,
          active: settings.switchPolicy === s.key,
          run: () => updateSettings({ switchPolicy: s.key }),
        });
      }
    }

    return out.slice(0, 40);
  }, [query, threads, catalog, settings.switchPolicy, selectThread, selectModel, updateSettings, startNewChat]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const runAt = (i) => {
    const r = results[i];
    if (!r) return;
    r.run();
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(cursor); }
  };

  // section headers rendered inline as the type changes
  let lastType = null;

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={onClose}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
            initial={reduce ? false : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-xl overflow-hidden rounded-2xl bg-elevated shadow-2xl ring-1 ring-line"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={18} className="text-tertiary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations, models, commands…"
                aria-label="Search"
                className="flex-1 bg-transparent py-3.5 text-[15px] text-primary placeholder:text-tertiary focus:outline-none"
              />
              <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-tertiary">esc</kbd>
            </div>

            <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5" role="listbox">
              {results.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-tertiary">No results for “{query}”</p>
              ) : (
                results.map((r, i) => {
                  const header = r.type !== lastType ? ((lastType = r.type), r.type) : null;
                  return (
                    <div key={r.id}>
                      {header && (
                        <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-tertiary">
                          {header}
                        </p>
                      )}
                      <button
                        role="option"
                        aria-selected={i === cursor}
                        data-active={i === cursor}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => runAt(i)}
                        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left
                          ${i === cursor ? "bg-hover" : ""}`}
                      >
                        <r.icon size={16} className="shrink-0 text-tertiary" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] text-primary">
                            <Highlight text={r.label} query={query} />
                          </span>
                          {r.sub && <span className="block truncate text-[12px] text-tertiary">{r.sub}</span>}
                        </span>
                        {r.active && <span className="text-[11px] text-accent">active</span>}
                        {i === cursor && <CornerDownLeft size={14} className="shrink-0 text-tertiary" />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-tertiary">
              <span className="flex items-center gap-1"><Command size={12} />K to open</span>
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span className="ml-auto">{results.length} results</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
