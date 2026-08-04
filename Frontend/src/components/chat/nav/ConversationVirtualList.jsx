import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { MoreHorizontal, Pin } from "lucide-react";
import { useChat } from "../../../context/ChatContext";
import { Highlight } from "./highlight";
import ConversationMenu from "./ConversationMenu";
import ConversationPreview from "./ConversationPreview";

const ROW_H = 38;
const OVERSCAN = 6;

/**
 * Virtualized conversation list. Renders only the visible window (+overscan) so
 * a large history stays smooth. Keyboard: ↑/↓ move, Enter opens. Hover peeks a
 * preview; the row menu and inline rename live here too.
 */
export default function ConversationVirtualList({ items, loading, query = "" }) {
  const { currentThreadId, selectThread, renameThread } = useChat();
  const scrollRef = useRef(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [active, setActive] = useState(-1);
  const [menuId, setMenuId] = useState(null);
  const [hover, setHover] = useState(null); // { threadId, top }
  const [rename, setRename] = useState(null); // { threadId, value }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const close = () => setMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = items.slice(start, end);

  const open = useCallback((id) => { selectThread(id); setHover(null); }, [selectThread]);

  const onKeyDown = (e) => {
    if (rename) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(total - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); open(items[active].threadId); }
  };

  // keep the keyboard-active row in view
  useEffect(() => {
    if (active < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const y = active * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  }, [active]);

  const commitRename = () => {
    if (rename?.value.trim()) renameThread(rename.threadId, rename.value.trim());
    setRename(null);
  };

  if (loading) {
    return (
      <div className="flex-1 space-y-1 overflow-hidden px-2 py-1" aria-hidden>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-[38px] items-center px-2.5">
            <div className="h-3 rounded bg-hover" style={{ width: `${55 + (i % 4) * 10}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (total === 0) {
    return <p className="px-4 py-3 text-[13px] text-tertiary">No conversations yet</p>;
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Conversations"
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      className="relative flex-1 overflow-y-auto px-2 outline-none"
    >
      <div style={{ height: total * ROW_H, position: "relative" }}>
        <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
          {visible.map((t, i) => {
            const idx = start + i;
            const isActive = t.threadId === currentThreadId;
            const isRenaming = rename?.threadId === t.threadId;
            return (
              <div
                key={t.threadId}
                role="option"
                aria-selected={isActive}
                data-active={idx === active}
                style={{ height: ROW_H }}
                onMouseEnter={(e) =>
                  !menuId && setHover({ threadId: t.threadId, top: e.currentTarget.getBoundingClientRect().top })
                }
                onMouseLeave={() => setHover(null)}
                onClick={() => !isRenaming && open(t.threadId)}
                className={`group/row relative flex items-center gap-1.5 rounded-lg px-2.5 text-[14px]
                  ${idx === active ? "ring-1 ring-line" : ""}
                  ${isActive ? "bg-hover" : "hover:bg-hover"} cursor-pointer transition-colors`}
              >
                {t.pinned && <Pin size={12} className="shrink-0 text-tertiary" />}

                {isRenaming ? (
                  <input
                    autoFocus
                    value={rename.value}
                    onChange={(e) => setRename({ ...rename, value: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRename(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded bg-app px-1.5 py-0.5 text-[14px] text-primary outline-none ring-1 ring-accent"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-primary [mask-image:linear-gradient(90deg,#000_85%,transparent)]">
                    <Highlight text={t.title} query={query} />
                  </span>
                )}

                {!isRenaming && (
                  <button
                    aria-label="Conversation options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHover(null);
                      setMenuId(menuId === t.threadId ? null : t.threadId);
                    }}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-tertiary opacity-0
                      transition-opacity hover:bg-active hover:text-primary
                      group-hover/row:opacity-100 focus-visible:opacity-100 focus:outline-none
                      aria-[expanded=true]:opacity-100"
                    aria-expanded={menuId === t.threadId}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                )}

                {menuId === t.threadId && (
                  <ConversationMenu
                    thread={t}
                    onClose={() => setMenuId(null)}
                    onRename={(th) => { setMenuId(null); setRename({ threadId: th.threadId, value: th.title }); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {hover && !menuId && !rename && (
          <ConversationPreview
            thread={items.find((t) => t.threadId === hover.threadId)}
            top={hover.top}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
