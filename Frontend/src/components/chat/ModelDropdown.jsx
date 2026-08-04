import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useChat } from "../../context/ChatContext";

const POLICIES = [
  { v: "auto", label: "Auto switch" },
  { v: "ask", label: "Ask before switching" },
  { v: "never", label: "Never auto switch" },
];

/**
 * Map the backend status to a *user-facing* label. Never expose backend
 * detail like "API key missing" — unconfigured providers are hidden entirely,
 * so the only statuses shown are Ready or a temporary "Unavailable".
 */
const STATUS = {
  ready: { label: "Ready", usable: true },
  rate_limited: { label: "Unavailable", usable: false },
  quota_reached: { label: "Unavailable", usable: false },
  offline: { label: "Unavailable", usable: false },
};
const statusOf = (m) => STATUS[m.status] || STATUS.offline;

/**
 * Header model picker — a plain dropdown grouped by provider. Only providers
 * that are actually configured appear; temporarily unavailable models are shown
 * disabled. Failover preference sits below a divider.
 */
export default function ModelDropdown() {
  const { catalog, selectModel, settings, updateSettings } = useChat();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Only configured providers are offered; group them by provider name.
  const groups = useMemo(() => {
    const byProvider = new Map();
    for (const m of catalog) {
      if (!m.configured) continue; // hide providers with no key — no backend detail leaked
      if (!byProvider.has(m.providerName)) byProvider.set(m.providerName, []);
      byProvider.get(m.providerName).push(m);
    }
    return [...byProvider.entries()];
  }, [catalog]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !wrapRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button className="cg-model" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        NovaGPT
        <ChevronDown size={16} className="cg-model-chevron" />
      </button>

      {open && (
        <div className="cg-menu" role="menu">
          {groups.length === 0 && (
            <p className="cg-menu-sub" style={{ padding: "10px 12px" }}>
              No models available right now.
            </p>
          )}

          {groups.map(([providerName, models]) => (
            <div key={providerName}>
              <p className="cg-menu-label">{providerName}</p>
              {models.map((model) => {
                const st = statusOf(model);
                return (
                  <button
                    key={model.id}
                    role="menuitem"
                    className="cg-menu-item"
                    aria-disabled={!st.usable}
                    disabled={!st.usable}
                    onClick={() => {
                      if (!st.usable) return;
                      selectModel(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className={`cg-dot ${st.usable ? "" : "is-off"}`} />
                    <span className="cg-menu-main">
                      <span className="cg-menu-name">
                        {model.name}
                        <span className={`cg-pill ${model.tier === "free" ? "cg-pill--free" : ""}`}>
                          {model.tier === "free" ? "Free" : "Paid"}
                        </span>
                      </span>
                      {!st.usable && <span className="cg-menu-sub">{st.label}</span>}
                    </span>
                    {model.id === settings.model && <Check size={16} className="cg-menu-check" />}
                  </button>
                );
              })}
            </div>
          ))}

          <div className="cg-menu-sep" />
          <p className="cg-menu-label">If a model is unavailable</p>

          {POLICIES.map((p) => (
            <button
              key={p.v}
              role="menuitemradio"
              aria-checked={settings.switchPolicy === p.v}
              className="cg-menu-item"
              onClick={() => {
                updateSettings({ switchPolicy: p.v });
                setOpen(false);
              }}
            >
              <span className="cg-menu-main">
                <span>{p.label}</span>
              </span>
              {settings.switchPolicy === p.v && <Check size={16} className="cg-menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
