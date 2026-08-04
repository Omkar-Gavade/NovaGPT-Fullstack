import { MODELS } from "../../data/models";

/** Auto-scrolling row of supported models (pauses on hover). */
export default function LogoMarquee() {
  const row = [...MODELS, ...MODELS];
  return (
    <div className="marquee" aria-label="Supported models">
      <p className="marquee-label">One interface for every major model</p>
      <div className="marquee-track">
        {row.map((m, i) => (
          <span className="marquee-item" key={`${m.id}-${i}`}>
            <span className="mono" style={{ background: m.gradient }}>
              {m.mono}
            </span>
            {m.name}
          </span>
        ))}
      </div>
    </div>
  );
}
