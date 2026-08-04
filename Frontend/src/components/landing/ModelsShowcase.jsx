import { Eye, Brain, Wrench } from "lucide-react";
import { MODELS } from "../../data/models";
import Reveal from "./Reveal";

const METERS = [
  { key: "speed", label: "Speed" },
  { key: "reasoning", label: "Reasoning" },
  { key: "context", label: "Context" },
];

function Cap({ on, icon: Icon, label }) {
  return (
    <span className={`cap ${on ? "cap--on" : ""}`}>
      <Icon size={12} />
      {label}
    </span>
  );
}

export default function ModelsShowcase() {
  return (
    <section className="section" id="models">
      <div className="section-head section-head--center">
        <Reveal>
          <span className="section-eyebrow">Models</span>
        </Reveal>
        <Reveal delay={0.05}>
          <h2 className="section-title">Pick the mind for the moment</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="section-lead">
            Frontier and local models, compared on the axes that actually matter.
            Swap freely — the interface stays the same.
          </p>
        </Reveal>
      </div>

      <div className="models-grid">
        {MODELS.map((m, i) => (
          <Reveal key={m.id} delay={(i % 4) * 0.04}>
            <div className="model-card">
              <div className="model-head">
                <span className="mono" style={{ background: m.gradient }}>
                  {m.mono}
                </span>
                <div>
                  <p className="model-name">{m.name}</p>
                  <span className="model-provider">{m.provider}</span>
                </div>
              </div>

              <div className="model-caps">
                <Cap on={m.caps.vision} icon={Eye} label="Vision" />
                <Cap on={m.caps.reasoning} icon={Brain} label="Reasoning" />
                <Cap on={m.caps.tools} icon={Wrench} label="Tools" />
              </div>

              <div className="model-meters">
                {METERS.map((mt) => (
                  <div className="meter-row" key={mt.key}>
                    <span className="meter-label">{mt.label}</span>
                    <span className="meter">
                      <span className="meter-fill" style={{ width: `${m.meters[mt.key]}%` }} />
                    </span>
                  </div>
                ))}
                <div className="meter-row" style={{ marginTop: 4 }}>
                  <span className="meter-label">Context</span>
                  <strong style={{ color: "var(--text)", fontWeight: 600 }}>{m.context}</strong>
                  <span style={{ marginLeft: "auto" }}>{m.cost}</span>
                </div>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
