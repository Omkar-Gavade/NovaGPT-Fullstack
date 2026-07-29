/**
 * Model catalog — the single source of truth for what NovaGPT can route to.
 *
 * One entry per option shown in the header dropdown. `speed` / `reasoning` are
 * 0-100 relative scores the router uses for ranking; `context` is the window in
 * tokens; `tier` is "free" | "paid". Adding a model is a data change only.
 */

export const CATALOG = [
  { id: "gemini-2.5-pro", provider: "gemini", name: "Gemini 2.5 Pro", speed: 74, reasoning: 94, vision: true, tools: true, context: 2_000_000, tier: "paid", cost: "$$" },
  { id: "gemini-2.5-flash", provider: "gemini", name: "Gemini Flash", speed: 96, reasoning: 82, vision: true, tools: true, context: 1_000_000, tier: "free", cost: "$" },
  { id: "claude-sonnet-4-5", provider: "claude", name: "Claude Sonnet", speed: 84, reasoning: 96, vision: true, tools: true, context: 200_000, tier: "paid", cost: "$$" },
  { id: "gpt-4o", provider: "openai", name: "GPT", speed: 82, reasoning: 92, vision: true, tools: true, context: 128_000, tier: "paid", cost: "$$" },
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek", speed: 80, reasoning: 90, vision: false, tools: true, context: 128_000, tier: "paid", cost: "$" },
  { id: "moonshot-v1-128k", provider: "kimi", name: "Kimi", speed: 78, reasoning: 84, vision: true, tools: true, context: 128_000, tier: "paid", cost: "$" },
  { id: "qwen-plus", provider: "qwen", name: "Qwen", speed: 85, reasoning: 83, vision: true, tools: true, context: 256_000, tier: "paid", cost: "$" },
  { id: "llama-3.3-70b-versatile", provider: "groq", name: "Llama", speed: 94, reasoning: 80, vision: false, tools: true, context: 128_000, tier: "free", cost: "$" },
  { id: "mistral-large-latest", provider: "mistral", name: "Mistral", speed: 86, reasoning: 85, vision: false, tools: true, context: 128_000, tier: "paid", cost: "$" },
  { id: "llama-3.1-8b-instant", provider: "groq", name: "Groq", speed: 99, reasoning: 72, vision: false, tools: true, context: 128_000, tier: "free", cost: "$" },
  { id: "openrouter/auto", provider: "openrouter", name: "OpenRouter", speed: 80, reasoning: 88, vision: true, tools: true, context: 200_000, tier: "paid", cost: "$$" },
  { id: "llama3.2", provider: "ollama", name: "Ollama", speed: 70, reasoning: 74, vision: false, tools: false, context: 128_000, tier: "free", cost: "Free" },

  // ---- Free-tier providers (Phase 6) -------------------------------------
  // Cerebras — wafer-scale inference, ~1M tokens/day free, OpenAI-compatible
  { id: "llama-3.3-70b", provider: "cerebras", name: "Llama 3.3 70B (Cerebras)", speed: 99, reasoning: 80, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },
  { id: "qwen-3-32b", provider: "cerebras", name: "Qwen3 32B (Cerebras)", speed: 98, reasoning: 86, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },

  // Groq — free dev tier (extra models)
  { id: "openai/gpt-oss-120b", provider: "groq", name: "GPT-OSS 120B (Groq)", speed: 96, reasoning: 88, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },

  // GitHub Models — free, OpenAI-compatible (Azure-hosted)
  { id: "openai/gpt-4o-mini", provider: "github", name: "GPT-4o mini (GitHub)", speed: 92, reasoning: 80, vision: true, tools: true, context: 128_000, tier: "free", cost: "Free" },
  { id: "meta/Llama-3.3-70B-Instruct", provider: "github", name: "Llama 3.3 (GitHub)", speed: 84, reasoning: 80, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },

  // NVIDIA NIM — free evaluation tier, OpenAI-compatible
  { id: "meta/llama-3.3-70b-instruct", provider: "nvidia", name: "Llama 3.3 (NVIDIA)", speed: 82, reasoning: 80, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },

  // Cloudflare Workers AI — free daily neurons, OpenAI-compatible
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "cloudflare", name: "Llama 3.3 (Cloudflare)", speed: 88, reasoning: 78, vision: false, tools: true, context: 24_000, tier: "free", cost: "Free" },

  // Cohere — trial API key, OpenAI-compatible endpoint
  { id: "command-r-plus", provider: "cohere", name: "Command R+", speed: 78, reasoning: 84, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },

  // Zhipu AI (GLM) — GLM-4-Flash is free, OpenAI-compatible
  { id: "glm-4-flash", provider: "zhipu", name: "GLM-4 Flash", speed: 90, reasoning: 80, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },
  { id: "glm-4v-flash", provider: "zhipu", name: "GLM-4V Flash", speed: 84, reasoning: 78, vision: true, tools: false, context: 8_000, tier: "free", cost: "Free" },

  // Hugging Face — free serverless inference router, OpenAI-compatible
  { id: "meta-llama/Llama-3.3-70B-Instruct", provider: "huggingface", name: "Llama 3.3 (HF)", speed: 76, reasoning: 80, vision: false, tools: false, context: 128_000, tier: "free", cost: "Free" },

  // Mistral — free experimental tier (extra model)
  { id: "open-mistral-nemo", provider: "mistral", name: "Mistral Nemo (Free)", speed: 90, reasoning: 76, vision: false, tools: true, context: 128_000, tier: "free", cost: "Free" },
];

export const modelsFor = (providerId) => CATALOG.filter((m) => m.provider === providerId);
export const findModel = (modelId) => CATALOG.find((m) => m.id === modelId);
