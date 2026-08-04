import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Sparkles } from "lucide-react";

const EXCHANGES = [
  {
    model: "Gemini 2.5 Flash",
    q: "Summarize our Q3 launch in one line.",
    a: "Q3 shipped the multi-model router, cut median latency 38%, and grew weekly actives 2.1×.",
  },
  {
    model: "Claude Sonnet",
    q: "Refactor this into a reusable hook.",
    a: "Extracted the fetch + cache logic into useResource(), with abort handling and a typed loading state.",
  },
  {
    model: "DeepSeek",
    q: "Explain vector search like I'm five.",
    a: "It turns words into dots on a map, then finds the dots sitting closest to yours.",
  },
];

/** Looping typed-answer preview that sells the streaming experience. */
export default function StreamingPreview() {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState(reduce ? EXCHANGES[0].a : "");

  useEffect(() => {
    if (reduce) return;
    const full = EXCHANGES[idx].a;
    setTyped("");
    let i = 0;
    const type = setInterval(() => {
      i += 1;
      setTyped(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(type);
        setTimeout(() => setIdx((v) => (v + 1) % EXCHANGES.length), 2600);
      }
    }, 22);
    return () => clearInterval(type);
  }, [idx, reduce]);

  const ex = EXCHANGES[idx];
  const done = typed.length >= ex.a.length;

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <span className="preview-dot" />
        <span className="preview-dot" />
        <span className="preview-dot" />
        <span className="preview-model">
          <Sparkles size={13} color="var(--accent)" />
          {ex.model}
        </span>
      </div>
      <div className="preview-body">
        <div className="preview-q">{ex.q}</div>
        <div className="preview-a">
          {typed}
          {!reduce && !done && <span className="stream-cursor" />}
        </div>
      </div>
    </div>
  );
}
