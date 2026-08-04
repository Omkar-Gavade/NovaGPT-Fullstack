import { Check, Github } from "lucide-react";
import Reveal from "./Reveal";

const POINTS = [
  "One Provider interface: generate, stream, vision, tools",
  "Strategy pattern — no provider logic hardcoded in routes",
  "Drop a folder in providers/, register it, ship",
  "Bring your own keys, or point at a local Ollama",
];

const CODE = `// providers/interfaces/Provider.js
export class Provider {
  async generate(messages, opts) {}     // full response
  async *stream(messages, opts) {}      // token stream
  async vision(images, prompt) {}       // multimodal
  async toolCalling(messages, tools) {} // function calls
}

// router picks an adapter, never hardcodes one
const provider = registry.resolve(model.id);
for await (const token of provider.stream(msgs, opts)) {
  send(token);
}`;

export default function DeveloperSection() {
  return (
    <section className="section">
      <div className="feature-grid" style={{ alignItems: "center" }}>
        <Reveal className="feature-span-3">
          <span className="section-eyebrow">For developers</span>
          <h2 className="section-title" style={{ marginBottom: "var(--sp-5)" }}>
            Add a provider in an afternoon
          </h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 28px", display: "grid", gap: 12 }}>
            {POINTS.map((p) => (
              <li key={p} style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "var(--text-muted)", fontSize: 15, lineHeight: 1.5 }}>
                <Check size={18} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
                {p}
              </li>
            ))}
          </ul>
          <a className="cta cta--ghost" href="https://github.com/nextlevelbuilder" target="_blank" rel="noreferrer">
            <Github size={17} /> View on GitHub
          </a>
        </Reveal>

        <Reveal className="feature-span-3" delay={0.1}>
          <div className="code-block" style={{ background: "color-mix(in srgb, var(--surface-raised) 70%, transparent)", backdropFilter: "blur(10px)" }}>
            <div className="code-head">
              <span className="code-lang">provider.js</span>
              <span className="code-lang" style={{ textTransform: "none" }}>strategy</span>
            </div>
            <pre className="code-body" style={{ fontSize: 12.5 }}>
              <code>{CODE}</code>
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
