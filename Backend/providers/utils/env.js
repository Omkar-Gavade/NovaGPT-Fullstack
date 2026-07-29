/**
 * Environment validation + a readable startup report.
 *
 * Hard requirements fail fast with a clear message. Provider keys are optional —
 * a provider with no key is simply skipped by the router — but we surface which
 * ones are active so misconfiguration is obvious at boot.
 */

const REQUIRED = [{ key: "MONGODB_URI", hint: "MongoDB connection string" }];

const PROVIDER_ENV = [
  { id: "gemini", keys: ["GEMINI_API_KEY"] },
  { id: "openai", keys: ["OPENAI_API_KEY"] },
  { id: "anthropic", keys: ["ANTHROPIC_API_KEY"] },
  { id: "deepseek", keys: ["DEEPSEEK_API_KEY"] },
  { id: "kimi", keys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"] },
  { id: "qwen", keys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"] },
  { id: "groq", keys: ["GROQ_API_KEY"] },
  { id: "mistral", keys: ["MISTRAL_API_KEY"] },
  { id: "openrouter", keys: ["OPENROUTER_API_KEY"] },
  { id: "cerebras", keys: ["CEREBRAS_API_KEY"] },
  { id: "github", keys: ["GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"] },
  { id: "nvidia", keys: ["NVIDIA_API_KEY"] },
  { id: "cloudflare", keys: ["CLOUDFLARE_API_TOKEN"] },
  { id: "cohere", keys: ["COHERE_API_KEY"] },
  { id: "zhipu", keys: ["ZHIPU_API_KEY"] },
  { id: "huggingface", keys: ["HF_TOKEN", "HUGGINGFACE_API_KEY"] },
  { id: "ollama", keys: ["OLLAMA_BASE_URL"], optional: true },
  { id: "openai-compatible", keys: ["CUSTOM_BASE_URL"], optional: true },
];

export function validateEnv({ exitOnError = true } = {}) {
  const missing = REQUIRED.filter((r) => !process.env[r.key]?.trim());
  const active = PROVIDER_ENV.filter((p) => p.keys.some((k) => process.env[k]?.trim()));

  if (missing.length) {
    console.error("\n✖ Missing required environment variables:");
    for (const m of missing) console.error(`  - ${m.key} (${m.hint})`);
    console.error("  Copy Backend/.env.example to Backend/.env and fill it in.\n");
    if (exitOnError) process.exit(1);
    return { ok: false, active: [] };
  }

  console.log(`\nNovaGPT providers configured: ${active.length}/${PROVIDER_ENV.length}`);
  for (const p of PROVIDER_ENV) {
    const on = p.keys.some((k) => process.env[k]?.trim());
    console.log(`  ${on ? "●" : "○"} ${p.id}${on ? "" : "  (no key — skipped)"}`);
  }
  if (active.length === 0) {
    console.warn("⚠ No provider keys set — chat will have nothing to route to.");
  }
  console.log("");

  return { ok: true, active: active.map((p) => p.id) };
}
