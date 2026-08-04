import { useNavigate } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import DotTextHero from "../DotTextHero";
import StreamingPreview from "./StreamingPreview";
import Reveal from "./Reveal";

/** Cinematic opener: centered dotted wordmark, value prop stacked beneath it. */
export default function Hero({ isDark }) {
  const navigate = useNavigate();

  return (
    <section className="hero">
      <Reveal>
        <span className="pill">
          <span className="pill-dot" />
          11 models · one interface
        </span>
      </Reveal>

      {/* preserved dotted NovaGPT wordmark — centered */}
      <div className="hero-wordmark">
        <DotTextHero isDark={isDark} />
      </div>

      <div className="hero-inner">
        <Reveal delay={0.05}>
          <h1 className="hero-title">
            The operating system for <span className="grad">working with AI</span>
          </h1>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="hero-sub">
            Route any prompt to the right model, stream the answer, and keep the
            thinking that matters — pinned, searchable, yours.
          </p>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="cta-row" style={{ justifyContent: "center" }}>
            <button className="cta cta--primary" onClick={() => navigate("/chat")}>
              Launch NovaGPT <ArrowRight size={17} />
            </button>
            <a className="cta cta--ghost" href="#models">
              <Sparkles size={16} /> Explore models
            </a>
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <StreamingPreview />
        </Reveal>
      </div>

      <div className="scroll-cue" aria-hidden="true">
        <span />
        Scroll
      </div>
    </section>
  );
}
