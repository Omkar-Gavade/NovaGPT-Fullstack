import { motion, useReducedMotion } from "motion/react";
import { Code2, PenLine, Lightbulb, GraduationCap, Sparkles } from "lucide-react";
import { useChat } from "../../context/ChatContext";

const PROMPTS = [
  { icon: Code2, title: "Write code", sub: "a debounce hook in React", text: "Write a reusable useDebounce hook in React with an example." },
  { icon: PenLine, title: "Draft something", sub: "a concise launch email", text: "Draft a concise, professional launch announcement email for a new feature." },
  { icon: Lightbulb, title: "Brainstorm", sub: "names for a dev tool", text: "Brainstorm 10 memorable names for a developer productivity tool." },
  { icon: GraduationCap, title: "Explain", sub: "how vector search works", text: "Explain how vector search works, simply, with a small code example." },
];

const QUICK = ["Summarize a document", "Analyze data", "Plan a project", "Improve my writing"];

/** Premium first-run state: greeting, animated suggested prompts, quick actions. */
export default function EmptyState() {
  const { sendMessage, activeModel } = useChat();
  const reduce = useReducedMotion();

  const container = { hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } };
  const item = reduce
    ? {}
    : { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } } };

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 pb-[12vh]">
      <motion.div variants={container} initial="hidden" animate="show" className="w-full max-w-2xl text-center">
        <motion.div variants={item} className="mb-5 inline-grid h-12 w-12 place-items-center rounded-2xl bg-elevated ring-1 ring-line">
          <Sparkles size={22} className="text-accent" />
        </motion.div>

        <motion.h1 variants={item} className="text-[28px] font-normal tracking-tight text-primary">
          What can I help with?
        </motion.h1>
        {activeModel && (
          <motion.p variants={item} className="mt-1.5 text-sm text-tertiary">
            Using {activeModel.name}
          </motion.p>
        )}

        <motion.div variants={item} className="mt-8 grid grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
          {PROMPTS.map((p) => (
            <button
              key={p.title}
              onClick={() => sendMessage(p.text)}
              className="group flex items-start gap-3 rounded-2xl bg-elevated/60 p-3.5 text-left ring-1 ring-line
                transition-[background,transform] duration-150 hover:bg-elevated hover:-translate-y-0.5
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/60"
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-app text-secondary
                transition-colors group-hover:text-primary">
                <p.icon size={17} />
              </span>
              <span>
                <span className="block text-sm font-medium text-primary">{p.title}</span>
                <span className="block text-[13px] text-tertiary">{p.sub}</span>
              </span>
            </button>
          ))}
        </motion.div>

        <motion.div variants={item} className="mt-4 flex flex-wrap justify-center gap-2">
          {QUICK.map((q) => (
            <button
              key={q}
              onClick={() => sendMessage(q)}
              className="rounded-full bg-elevated/60 px-3.5 py-1.5 text-[13px] text-secondary ring-1 ring-line
                transition-colors duration-150 hover:bg-elevated hover:text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/60"
            >
              {q}
            </button>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
