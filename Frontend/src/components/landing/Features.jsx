import { Layers, Zap, Pin, Search, ShieldCheck } from "lucide-react";
import Reveal from "./Reveal";

const FEATURES = [
  {
    span: "feature-span-3",
    icon: Layers,
    title: "One router, every model",
    text: "Send a prompt and let the router pick — Gemini, Claude, GPT, DeepSeek, or your local Ollama. Switch mid-conversation without losing context.",
  },
  {
    span: "feature-span-3",
    icon: Zap,
    title: "Streams in real time",
    text: "Tokens land the moment they're generated, with a live cursor and graceful fallbacks. No spinners pretending to be progress.",
  },
  {
    span: "feature-span-2",
    icon: Pin,
    title: "Pin what matters",
    text: "Keep key answers one click away in the inspector.",
  },
  {
    span: "feature-span-2",
    icon: Search,
    title: "Search everything",
    text: "Find any message across every conversation, instantly.",
  },
  {
    span: "feature-span-2",
    icon: ShieldCheck,
    title: "Private by default",
    text: "Your keys, your data. Bring your own providers.",
  },
];

function trackGlow(e) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--gx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--gy", `${e.clientY - r.top}px`);
}

export default function Features() {
  return (
    <section className="section" id="features">
      <div className="section-head">
        <Reveal>
          <span className="section-eyebrow">Capabilities</span>
        </Reveal>
        <Reveal delay={0.05}>
          <h2 className="section-title">Everything you'd expect. Assembled better.</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="section-lead">
            The pieces of a serious AI workspace — routing, streaming, memory,
            search — designed to feel like one product, not a pile of features.
          </p>
        </Reveal>
      </div>

      <div className="feature-grid">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.05} className={f.span}>
            <div className="glass" onMouseMove={trackGlow} style={{ height: "100%" }}>
              <div className="feature-icon">
                <f.icon size={20} />
              </div>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-text">{f.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
