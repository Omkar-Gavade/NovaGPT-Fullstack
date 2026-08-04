import { useCallback, useEffect, useRef, useState } from "react";

const HIGHLIGHT_MS = 1000;

/**
 * One reusable scroll manager for the whole chat. It owns:
 *   - auto-scroll to the bottom on new messages
 *   - scroll-to a specific message (outline / pin / bookmark click)
 *   - the highlight animation, applied via the `.is-highlighted` CSS class
 *
 * No component queries the DOM for scrolling on its own anymore.
 *
 * @param scrollRef  ref to the scrollable container
 * @param deps       values that, when changed, trigger auto-scroll to bottom
 */
export function useScrollToMessage(scrollRef, deps) {
  const [targetId, setTargetId] = useState(null);
  const highlightTimer = useRef(null);

  // Auto-scroll to bottom as the conversation grows / streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Scroll to a requested message and briefly highlight its bubble.
  useEffect(() => {
    if (!targetId) return;

    const row = document.getElementById(`msg-${targetId}`);
    const bubble = row?.querySelector(".msg-bubble");
    if (!bubble) return;

    row.scrollIntoView({ behavior: "smooth", block: "center" });
    bubble.classList.add("is-highlighted");

    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      bubble.classList.remove("is-highlighted");
      setTargetId(null);
    }, HIGHLIGHT_MS);

    return () => clearTimeout(highlightTimer.current);
  }, [targetId]);

  /** Request a scroll to a message id (re-clicking the same id re-triggers). */
  const scrollToMessage = useCallback((id) => {
    if (!id) return;
    setTargetId(null);
    requestAnimationFrame(() => setTargetId(id));
  }, []);

  return scrollToMessage;
}
