import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import Reveal from "./Reveal";

const COLUMNS = [
  { title: "Product", links: ["Chat", "Models", "Pricing", "Changelog"] },
  { title: "Developers", links: ["Docs", "API", "Providers", "GitHub"] },
  { title: "Company", links: ["About", "Blog", "Careers", "Contact"] },
];

export default function SiteFooter() {
  const navigate = useNavigate();

  return (
    <>
      <div className="cta-band">
        <Reveal>
          <div className="cta-card">
            <h2 className="section-title" style={{ margin: "0 auto var(--sp-4)", maxWidth: "16ch" }}>
              Meet the AI OS you'll actually keep open
            </h2>
            <p className="section-lead" style={{ margin: "0 auto 28px" }}>
              Every model, one interface, none of the tab-juggling.
            </p>
            <div className="cta-row" style={{ justifyContent: "center" }}>
              <button className="cta cta--primary" onClick={() => navigate("/chat")}>
                Launch NovaGPT <ArrowRight size={17} />
              </button>
              <button className="cta cta--ghost" onClick={() => navigate("/auth")}>
                Create account
              </button>
            </div>
          </div>
        </Reveal>
      </div>

      <footer className="site-footer">
        <div className="footer-inner">
          <div>
            <div className="footer-brand-row">
              <span className="brand-logo">N</span>
              <span className="brand-title">NovaGPT</span>
            </div>
            <p className="footer-tag">The operating system for working with AI. Route, stream, and keep the thinking that matters.</p>
          </div>

          {COLUMNS.map((col) => (
            <div className="footer-col" key={col.title}>
              <h4>{col.title}</h4>
              {col.links.map((l) => (
                <a href="#" key={l}>
                  {l}
                </a>
              ))}
            </div>
          ))}
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} NovaGPT. Built by Omkar Gavade.</span>
          <span>Privacy · Terms</span>
        </div>
      </footer>
    </>
  );
}
