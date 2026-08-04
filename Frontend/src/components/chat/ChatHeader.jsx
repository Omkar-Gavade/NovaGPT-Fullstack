import { PanelLeft, SquarePen, Share, MoreHorizontal } from "lucide-react";
import ModelDropdown from "./ModelDropdown";
import { useChat } from "../../context/ChatContext";

/** Simple top bar: sidebar toggle (when collapsed), model dropdown, share. */
export default function ChatHeader({ sidebarHidden, onToggleSidebar }) {
  const { startNewChat, isStreaming, activeModel } = useChat();

  return (
    <header className="cg-header">
      {sidebarHidden && (
        <>
          <button className="cg-icon-btn" onClick={onToggleSidebar} aria-label="Open sidebar">
            <PanelLeft size={19} />
          </button>
          <button className="cg-icon-btn" onClick={startNewChat} aria-label="New chat">
            <SquarePen size={19} />
          </button>
        </>
      )}

      <ModelDropdown />

      {isStreaming && activeModel && (
        <span className="cg-generating" aria-live="polite">
          <span className="cg-gen-dot" />
          {activeModel.providerName}
        </span>
      )}

      <div className="cg-header-right">
        <button className="cg-share" aria-label="Share chat">
          <Share size={16} />
          <span>Share</span>
        </button>
        <button className="cg-icon-btn" aria-label="More options">
          <MoreHorizontal size={19} />
        </button>
      </div>
    </header>
  );
}
