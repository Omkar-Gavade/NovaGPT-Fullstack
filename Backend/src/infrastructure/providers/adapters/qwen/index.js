import { OpenAIDialectProvider } from "../../shared/OpenAIDialectProvider.js";

/**
 * Qwen (Alibaba DashScope) — best-in-class multilingual, especially CJK, plus a
 * 256K window that makes it the only non-Gemini option for very long context.
 *
 * Region-dependent endpoints: the international endpoint is the default and the
 * mainland one is reachable through `settings.baseURL`.
 */
export const descriptor = {
  id: "qwen",
  name: "Qwen",
  dialect: "openai",
  adapterVersion: "1.0.0",
  envKeys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  models: [
    {
      id: "qwen-plus",
      displayName: "Qwen Plus",
      capabilities: {
        streaming: true, vision: true, json: true, toolCalling: true,
        contextWindow: 256_000, maxOutputTokens: 8192,
        reasoning: 83, coding: 82, multilingual: 96, speed: 85,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
    {
      // **Closes the documented single point of failure above 256K.**
      //
      // Context ≥ 1M was Gemini-only, so a conversation that needed a window
      // that large had no failover destination at all: if Gemini was down, the
      // request simply failed
      // (docs/backend/05-capability-matrix.md#coverage-analysis--why-this-set-is-sufficient).
      //
      // Alibaba rather than another Google surface, because failure
      // independence is the whole point — a second route to the same vendor
      // would close the gap on paper and not in an outage.
      //
      // Added as *data*: no adapter code changed, because Qwen already speaks
      // the OpenAI dialect. That is the architecture's claim about onboarding
      // being tested rather than asserted.
      id: "qwen-long",
      displayName: "Qwen Long",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 10_000_000, maxOutputTokens: 8192,
        reasoning: 76, coding: 70, multilingual: 92, speed: 70,
      },
      // Deliberately unset. Every other model here carries a date because it
      // was checked against the live API; this one has never been called, so
      // claiming a date would be the exact dishonesty `verifiedAt` exists to
      // prevent. It ships dark until someone runs `npm run test:live` with a
      // DashScope key.
      tier: "paid", costBand: "$", verifiedAt: null,
    },
    {
      id: "qwen-turbo",
      displayName: "Qwen Turbo",
      capabilities: {
        streaming: true, json: true, toolCalling: true,
        contextWindow: 128_000, maxOutputTokens: 8192,
        reasoning: 74, coding: 72, multilingual: 92, speed: 94,
      },
      tier: "paid", costBand: "$", verifiedAt: "2026-08-01",
    },
  ],
};

export class Adapter extends OpenAIDialectProvider {
  constructor(config) {
    super({
      ...config,
      baseURL: config.settings?.baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      embeddingModel: "text-embedding-v3",
    });
  }
}
