import Reveal from "./Reveal";

const STEPS = [
  {
    step: "Ask",
    title: "Start anywhere",
    text: "Type a question, paste code, or drop a file. One composer, every model behind it.",
  },
  {
    step: "Route",
    title: "The right model answers",
    text: "The router weighs speed, reasoning, vision and cost, then dispatches to the best provider for the job.",
  },
  {
    step: "Stream",
    title: "Watch it think",
    text: "Tokens arrive live with a real cursor. Reasoning and vision indicators show what the model is doing.",
  },
  {
    step: "Keep",
    title: "Nothing gets lost",
    text: "Pin, bookmark, and search across every conversation. Your thinking compounds instead of scrolling away.",
  },
];

export default function WhyTimeline() {
  return (
    <section className="section">
      <div className="section-head">
        <Reveal>
          <span className="section-eyebrow">How it works</span>
        </Reveal>
        <Reveal delay={0.05}>
          <h2 className="section-title">From prompt to kept knowledge</h2>
        </Reveal>
      </div>

      <div className="timeline">
        {STEPS.map((s, i) => (
          <Reveal key={s.step} delay={i * 0.06} className="tl-item">
            <p className="tl-step">{`0${i + 1} · ${s.step}`}</p>
            <h3 className="tl-title">{s.title}</h3>
            <p className="tl-text">{s.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
