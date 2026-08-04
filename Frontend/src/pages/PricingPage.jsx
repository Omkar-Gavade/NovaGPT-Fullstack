import { motion } from "framer-motion";
import { useState } from "react";
import Navbar from "../components/Navbar";

export default function PricingPage({ isDark, toggleTheme }) {

  // 🔥 Currency Rates (static for now)
  const rates = {
    USD: 1,
    INR: 83,
    EUR: 0.92,
    GBP: 0.78,
    JPY: 150,
    AUD: 1.5,
    CAD: 1.35,
  };

  const symbols = {
    USD: "$",
    INR: "₹",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    AUD: "A$",
    CAD: "C$",
  };

  const [currency, setCurrency] = useState("USD");

  const convert = (usd) => {
    return Math.round(usd * rates[currency]);
  };

  const plans = [
    {
      name: "Free",
      price: 0,
      desc: "For casual use",
      features: [
        "Basic chat access",
        "Limited history",
        "Standard AI responses",
      ],
      highlight: false,
    },
    {
      name: "Pro",
      price: 10,
      desc: "For serious users",
      features: [
        "Unlimited chats",
        "Bookmark & pin messages",
        "Multi-model workspace & router",
        "Faster responses",
      ],
      highlight: true,
    },
    {
      name: "Team",
      price: 25,
      desc: "For teams & collaboration",
      features: [
        "Everything in Pro",
        "Shared collections",
        "Team workspace",
        "Priority support",
      ],
      highlight: false,
    },
  ];

  return (
    <div className="min-h-screen bg-white dark:bg-black">

      <Navbar isDark={isDark} toggleTheme={toggleTheme} />

      {/* HERO */}
      <section className="pt-40 pb-16 px-6 text-center">
        <h1 className="text-5xl md:text-6xl font-semibold mb-4 text-gray-900 dark:text-white">
          Simple pricing.
        </h1>

        <p className="text-lg text-gray-600 dark:text-gray-400 mb-6">
          Choose a plan that fits how you think and work.
        </p>

        {/* 🔥 CURRENCY SWITCH */}
        <div className="flex justify-center gap-2 flex-wrap">
          {Object.keys(rates).map((cur) => (
            <button
              key={cur}
              onClick={() => setCurrency(cur)}
              className={`
                px-3 py-1 text-sm rounded-full border transition
                ${
                  currency === cur
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-gray-300 dark:border-white/20 text-gray-700 dark:text-gray-300"
                }
              `}
            >
              {cur}
            </button>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section className="pb-32 px-6">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">

          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              whileHover={{ y: -10, scale: 1.03 }}
              className={`
                group flex flex-col h-full
                p-8 rounded-3xl border transition-all duration-300

                ${
                  plan.highlight
                    ? "bg-blue-50 dark:bg-white/10 border-blue-300 dark:border-blue-500/30 shadow-lg"
                    : "bg-white dark:bg-white/5 border-gray-200 dark:border-white/10"
                }
              `}
            >

              {/* BADGE */}
              {plan.highlight && (
                <div className="text-xs px-3 py-1 mb-4 w-fit rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">
                  Most Popular
                </div>
              )}

              {/* TITLE */}
              <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
                {plan.name}
              </h3>

              {/* PRICE */}
              <div className="mb-6">
                <p className="text-3xl font-bold text-gray-900 dark:text-white">
                  {symbols[currency]}{convert(plan.price)}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  / month
                </p>
              </div>

              {/* DESC */}
              <p className="mb-6 text-gray-600 dark:text-gray-400">
                {plan.desc}
              </p>

              {/* FEATURES */}
              <ul className="space-y-3 mb-8 text-sm !text-gray-900 dark:!text-gray-200">
  {plan.features.map((f) => (
    <li key={f} className="flex items-start gap-2">
      <span className="text-blue-600 mt-[2px]">•</span>
      <span className="!text-gray-900 dark:!text-gray-200">
        {f}
      </span>
    </li>
  ))}
</ul>

              {/* 🔥 BUTTON FIXED ALIGNMENT */}
              <button
                className={`
                  mt-auto w-full py-3 rounded-full font-medium transition

                  ${
                    plan.highlight
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-black"
                  }
                `}
              >
                Get Started
              </button>

            </motion.div>
          ))}

        </div>
      </section>

    </div>
  );
}