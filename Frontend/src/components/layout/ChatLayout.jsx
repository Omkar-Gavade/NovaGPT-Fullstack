import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import ChatSidebar from "../chat/ChatSidebar";
import ChatHeader from "../chat/ChatHeader";
import ChatMessages from "../chat/ChatMessages";
import ChatInput from "../chat/ChatInput";
import CommandPalette from "../chat/nav/CommandPalette";

/**
 * Chat shell: conversation sidebar + centered thread + floating composer.
 * Desktop collapses the sidebar in place; mobile slides it over a backdrop.
 */
export default function ChatLayout() {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  // ⌘K / Ctrl+K opens the global command palette
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isMobile) setMobileOpen((v) => !v);
    else setCollapsed((v) => !v);
  }, [isMobile]);

  // the model dropdown lives in the header; the notice can ask us to open it
  const focusModelMenu = useCallback(() => {
    document.querySelector(".cg-model")?.click();
  }, []);

  return (
    <div className="cg-app">
      <ChatSidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <main className="cg-main">
        <ChatHeader
          sidebarHidden={isMobile || collapsed}
          onToggleSidebar={toggleSidebar}
        />
        <ChatMessages />
        <ChatInput onOpenModels={focusModelMenu} />
      </main>

      {isMobile && mobileOpen && (
        <div className="cg-backdrop" onClick={() => setMobileOpen(false)} />
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
