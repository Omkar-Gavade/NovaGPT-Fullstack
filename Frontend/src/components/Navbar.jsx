import { Moon, Sun, ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { NavLink, Link, useNavigate } from "react-router-dom";

const linkClass = ({ isActive }) =>
  `relative text-sm transition-colors ${
    isActive
      ? "text-neutral-900 dark:text-white"
      : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
  }`;

export default function Navbar({ isDark, toggleTheme }) {
  const navigate = useNavigate();

  return (
    <motion.nav
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="fixed top-4 left-0 right-0 z-50 px-4"
    >
      <div className="max-w-5xl mx-auto">
        <div
          className="
            flex items-center justify-between
            rounded-2xl px-4 py-2.5
            bg-white/70 dark:bg-[#111214]/70
            backdrop-blur-xl
            border border-black/[0.06] dark:border-white/[0.08]
            shadow-[0_2px_16px_rgba(0,0,0,0.06)]
          "
        >
          {/* LEFT */}
          <div className="flex items-center gap-7">
            <Link to="/" className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-[#8b76ff] to-[#6e56cf] text-[13px] font-bold text-white">
                N
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-white">
                NovaGPT
              </span>
            </Link>

            <div className="hidden md:flex items-center gap-6">
              <a href="#features" className={linkClass({ isActive: false })}>
                Product
              </a>
              <NavLink to="/pricing" className={linkClass}>
                Pricing
              </NavLink>
              <NavLink to="/docs" className={linkClass}>
                Docs
              </NavLink>
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
              className="
                grid h-9 w-9 place-items-center rounded-lg
                text-neutral-500 dark:text-neutral-400
                hover:bg-black/[0.04] dark:hover:bg-white/[0.06]
                hover:text-neutral-900 dark:hover:text-white
                transition-colors
              "
            >
              {isDark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>

            <button
              onClick={() => navigate("/auth")}
              className="
                group inline-flex items-center gap-1.5
                rounded-lg px-4 py-2 text-sm font-medium
                bg-neutral-900 text-white
                dark:bg-white dark:text-neutral-900
                hover:opacity-90 active:scale-[0.97]
                transition
              "
            >
              Get started
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </div>
    </motion.nav>
  );
}
