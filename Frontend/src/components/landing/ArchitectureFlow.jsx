import { Fragment } from "react";
import { Monitor, SlidersHorizontal, GitBranch, Boxes, MessageSquareText, ChevronRight } from "lucide-react";
import Reveal from "./Reveal";

const NODES = [
  { icon: Monitor, title: "Frontend", sub: "React composer" },
  { icon: SlidersHorizontal, title: "Model selector", sub: "Choose or auto" },
  { icon: GitBranch, title: "Router", sub: "Weighs the request" },
  { icon: Boxes, title: "Provider adapter", sub: "Strategy pattern" },
  { icon: MessageSquareText, title: "Response", sub: "Streamed back" },
];

export default function ArchitectureFlow() {
  return (
    <section className="section">
      <div className="section-head section-head--center">
        <Reveal>
          <span className="section-eyebrow">Architecture</span>
        </Reveal>
        <Reveal delay={0.05}>
          <h2 className="section-title">A clean path for every request</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="section-lead">
            Each provider implements the same contract, so adding a new one takes
            minutes — not a rewrite.
          </p>
        </Reveal>
      </div>

      <Reveal>
        <div className="flow">
          {NODES.map((n, i) => (
            <Fragment key={n.title}>
              <div className="flow-node">
                <div className="flow-node-icon">
                  <n.icon size={20} />
                </div>
                <p className="flow-node-title">{n.title}</p>
                <p className="flow-node-sub">{n.sub}</p>
              </div>
              {i < NODES.length - 1 && (
                <div className="flow-arrow" aria-hidden="true">
                  <ChevronRight size={18} />
                  <span className="spark">
                    <ChevronRight size={18} />
                  </span>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
