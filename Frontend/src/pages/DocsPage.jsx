import { motion } from "framer-motion";
import Navbar from "../components/Navbar";

export default function DocsPage({ isDark, toggleTheme }) {
  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-white overflow-x-hidden">

      <Navbar isDark={isDark} toggleTheme={toggleTheme} />

      {/* 🔥 HERO */}
      <section className="min-h-screen flex items-center px-6 md:px-20">
        <div className="max-w-5xl">

          <motion.h1
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-6xl md:text-8xl font-semibold tracking-tight leading-[1.05]"
          >
            Master how you think.
          </motion.h1>

          <p className="mt-8 text-xl text-gray-600 dark:text-gray-400 max-w-xl">
            NovaGPT is not a chatbot.  
            It’s a system designed for structured thinking and deep work.
          </p>

        </div>
      </section>

      {/* 🔥 SECTIONS */}
      <BigSection
        title="Conversations become structured knowledge."
        desc="Every interaction is preserved, navigable, and reusable. You don’t lose ideas — you evolve them."
      />

      <BigSection
        title="Navigate like a document, not a chat."
        desc="Jump, search, and move across conversations without friction. No more endless scrolling."
      />

      <BigSection
        title="Save and organize intelligence."
        desc="Switch models mid-conversation, tune generation settings, and keep every provider one keystroke away."
      />

      <BigSection
        title="Designed for clarity and depth."
        desc="Minimal interface. Maximum thinking power. Built for people who work seriously."
      />

      {/* 🔥 FINAL */}
      <section className="min-h-screen flex items-center justify-center px-6 text-center">
        <div>

          <h2 className="text-5xl md:text-7xl font-semibold mb-8">
            Start thinking differently.
          </h2>

          <button className="
            px-8 py-4 rounded-full text-lg font-medium
            bg-gradient-to-r from-blue-600 to-purple-500
            text-white shadow-2xl
          ">
            Try NovaGPT →
          </button>

        </div>
      </section>

    </div>
  );
}


// 🔥 BIG SECTION COMPONENT (KEY DIFFERENCE)
function BigSection({ title, desc }) {
  return (
    <section className="min-h-screen flex items-center px-6 md:px-20 relative">

      {/* BACKGROUND DEPTH */}
      <div className="absolute inset-0 -z-10">
        <div className="
          absolute inset-0 opacity-40
          bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/10
          blur-2xl
        " />
      </div>

      <div className="max-w-4xl">

        <motion.h2
          initial={{ opacity: 0, y: 60 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="text-5xl md:text-7xl font-semibold leading-[1.1] tracking-tight"
        >
          {title}
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="mt-8 text-xl text-gray-600 dark:text-gray-400 max-w-xl"
        >
          {desc}
        </motion.p>

      </div>

    </section>
  );
}