import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SquarePen, Library, PanelLeft, X, LogOut } from "lucide-react";
import { useChat } from "../../context/ChatContext";
import { useAuth } from "../../context/AuthContext";
import ConversationVirtualList from "./nav/ConversationVirtualList";

/*
 * Left conversation sidebar.
 *
 * Everything here is backed by something real. The "Scheduled", "Plugins",
 * "Codex" and "More" rows, the two fake pinned entries and the seven fake
 * projects are gone: they were static markup wired to nothing, and they pushed
 * the actual conversation list below the fold — which is why a signed-in user
 * with real threads saw a sidebar that looked like someone else's.
 *
 * There is no separate "Pinned" section either, and that is not an omission:
 * pinning is real, and `ChatContext` already sorts pinned conversations to the
 * top of the list below. A second section would render the same threads twice.
 */

function NavRow({ icon: Icon, label, onClick }) {
  return (
    <button className="cg-nav-item" onClick={onClick}>
      <Icon size={18} /> <span className="cg-nav-label">{label}</span>
    </button>
  );
}

/** Two letters for the avatar, from whatever the account actually has. */
function initials(user) {
  const source = user?.displayName?.trim() || user?.email || "";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function ChatSidebar({ collapsed, mobileOpen, onToggle, onCloseMobile }) {
  const { threads, threadsLoading, startNewChat } = useChat();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = threads.filter((t) => !t.archived);
    if (!q) return base;
    // Titles only. The list endpoint projects message bodies out — loading
    // every message of every thread to render a sidebar is the easiest way to
    // make it slow — so there is nothing else here to match against.
    return base.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, query]);

  const signOut = async () => {
    await logout();
    navigate("/auth", { replace: true });
  };

  return (
    <aside
      className={`cg-side ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-open" : ""}`}
      aria-label="Conversations"
    >
      {/* header: logo · search · collapse */}
      <div className="cg-side-top">
        <span className="cg-side-logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 2c.5 3.7 2.3 5.5 6 6-3.7.5-5.5 2.3-6 6-.5-3.7-2.3-5.5-6-6 3.7-.5 5.5-2.3 6-6Z" fill="currentColor" />
          </svg>
        </span>
        <div className="cg-side-top-actions">
          <button
            className="cg-icon-btn"
            onClick={() => { setSearching((v) => !v); setQuery(""); }}
            aria-label="Search chats"
          >
            {searching ? <X size={19} /> : <Search size={19} />}
          </button>
          <button className="cg-icon-btn" onClick={onToggle} aria-label="Collapse sidebar">
            <PanelLeft size={19} />
          </button>
        </div>
      </div>

      <div className="cg-side-nav">
        {searching ? (
          <input
            autoFocus
            className="cg-input"
            style={{ width: "100%", padding: "8px 10px", fontSize: 14 }}
            placeholder="Search chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search chats"
          />
        ) : (
          <>
            <NavRow
              icon={SquarePen}
              label="New chat"
              onClick={() => { startNewChat(); onCloseMobile?.(); }}
            />
            <NavRow icon={Library} label="Library" onClick={() => navigate("/")} />
          </>
        )}
      </div>

      <p className="cg-side-label">{query ? "Results" : "Chats"}</p>
      <ConversationVirtualList items={items} loading={threadsLoading} query={query} />

      {/* account */}
      <div className="cg-side-foot">
        <div className="cg-user" aria-label="Signed in account">
          <span className="cg-avatar">{initials(user)}</span>
          <span className="cg-user-text">
            <span className="cg-user-name">{user?.displayName || user?.email || "Account"}</span>
            <span className="cg-user-plan">{user?.role === "admin" ? "Admin" : "Member"}</span>
          </span>
          <button className="cg-icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </div>
    </aside>
  );
}
