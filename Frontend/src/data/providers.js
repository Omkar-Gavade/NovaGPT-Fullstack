/**
 * Provider brand metadata — monogram, gradient and accent colour per provider.
 * The live model catalog comes from the backend (`GET /api/models`); this file
 * only supplies the visuals so the UI can render a model it has never seen.
 */
export const PROVIDER_BRAND = {
  gemini: { name: "Google", mono: "G", color: "#4285F4", gradient: "linear-gradient(135deg,#4285F4,#9B72CB)" },
  openai: { name: "OpenAI", mono: "O", color: "#10A37F", gradient: "linear-gradient(135deg,#10A37F,#0B7C63)" },
  claude: { name: "Anthropic", mono: "C", color: "#D97757", gradient: "linear-gradient(135deg,#D97757,#B45309)" },
  deepseek: { name: "DeepSeek", mono: "D", color: "#4D6BFE", gradient: "linear-gradient(135deg,#4D6BFE,#2138B0)" },
  kimi: { name: "Moonshot", mono: "K", color: "#7C6BF0", gradient: "linear-gradient(135deg,#7C6BF0,#3B2E9E)" },
  qwen: { name: "Alibaba", mono: "Q", color: "#8B5CF6", gradient: "linear-gradient(135deg,#615CED,#8B5CF6)" },
  groq: { name: "Groq", mono: "L", color: "#F55036", gradient: "linear-gradient(135deg,#F55036,#B7280F)" },
  mistral: { name: "Mistral AI", mono: "M", color: "#FF7000", gradient: "linear-gradient(135deg,#FF7000,#C2410C)" },
  openrouter: { name: "OpenRouter", mono: "R", color: "#6467F2", gradient: "linear-gradient(135deg,#6467F2,#4338CA)" },
  ollama: { name: "Local", mono: "◐", color: "#9AA0AA", gradient: "linear-gradient(135deg,#3F3F46,#18181B)" },
  "openai-compatible": { name: "Custom", mono: "{}", color: "#7C8698", gradient: "linear-gradient(135deg,#64748B,#334155)" },
  // ---- free-tier providers (Phase 6) ----
  cerebras: { name: "Cerebras", mono: "Ce", color: "#F97316", gradient: "linear-gradient(135deg,#FB923C,#C2410C)" },
  github: { name: "GitHub Models", mono: "◑", color: "#8B949E", gradient: "linear-gradient(135deg,#6E7681,#24292E)" },
  nvidia: { name: "NVIDIA NIM", mono: "N", color: "#76B900", gradient: "linear-gradient(135deg,#76B900,#4B7300)" },
  cloudflare: { name: "Cloudflare", mono: "☁", color: "#F38020", gradient: "linear-gradient(135deg,#F6821F,#B45309)" },
  cohere: { name: "Cohere", mono: "Co", color: "#39594D", gradient: "linear-gradient(135deg,#7A5CFF,#39594D)" },
  zhipu: { name: "Zhipu GLM", mono: "GL", color: "#3859FF", gradient: "linear-gradient(135deg,#3859FF,#1E2FB0)" },
  huggingface: { name: "Hugging Face", mono: "🤗", color: "#FFD21E", gradient: "linear-gradient(135deg,#FFD21E,#FF9D00)" },
};

export const brandFor = (providerId) =>
  PROVIDER_BRAND[providerId] || { name: providerId, mono: "?", color: "#7C8698", gradient: "linear-gradient(135deg,#64748B,#334155)" };

/** Provider-level cards used by the landing page and auth constellation. */
export const PROVIDERS = [
  { id: "gemini", label: "Gemini", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 96, reasoning: 82, context: 90 }, context: "1M", cost: "Free tier" },
  { id: "claude", label: "Claude", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 84, reasoning: 96, context: 80 }, context: "200K", cost: "$$" },
  { id: "openai", label: "GPT", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 82, reasoning: 92, context: 78 }, context: "128K", cost: "$$" },
  { id: "deepseek", label: "DeepSeek", caps: { vision: false, reasoning: true, tools: true }, meters: { speed: 80, reasoning: 90, context: 72 }, context: "128K", cost: "$" },
  { id: "kimi", label: "Kimi", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 78, reasoning: 84, context: 95 }, context: "128K", cost: "$" },
  { id: "qwen", label: "Qwen", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 85, reasoning: 83, context: 82 }, context: "256K", cost: "$" },
  { id: "groq", label: "Llama on Groq", caps: { vision: false, reasoning: true, tools: true }, meters: { speed: 99, reasoning: 80, context: 70 }, context: "128K", cost: "Free tier" },
  { id: "mistral", label: "Mistral", caps: { vision: false, reasoning: true, tools: true }, meters: { speed: 86, reasoning: 85, context: 68 }, context: "128K", cost: "$" },
  { id: "openrouter", label: "OpenRouter", caps: { vision: true, reasoning: true, tools: true }, meters: { speed: 80, reasoning: 88, context: 85 }, context: "Varies", cost: "$$" },
  { id: "ollama", label: "Ollama", caps: { vision: false, reasoning: true, tools: false }, meters: { speed: 70, reasoning: 74, context: 64 }, context: "Local", cost: "Free" },
  { id: "openai-compatible", label: "OpenAI-compatible", caps: { vision: false, reasoning: true, tools: true }, meters: { speed: 78, reasoning: 80, context: 74 }, context: "Custom", cost: "—" },
].map((p) => ({ ...p, ...brandFor(p.id), name: p.label, provider: brandFor(p.id).name }));
