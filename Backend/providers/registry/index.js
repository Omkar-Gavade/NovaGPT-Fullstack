import { GeminiProvider } from "../adapters/gemini/index.js";
import { OpenAIProvider } from "../adapters/openai/index.js";
import { ClaudeProvider } from "../adapters/anthropic/index.js";
import { DeepSeekProvider } from "../adapters/deepseek/index.js";
import { KimiProvider } from "../adapters/kimi/index.js";
import { QwenProvider } from "../adapters/qwen/index.js";
import { GroqProvider } from "../adapters/groq/index.js";
import { MistralProvider } from "../adapters/mistral/index.js";
import { OpenRouterProvider } from "../adapters/openrouter/index.js";
import { OllamaProvider } from "../adapters/ollama/index.js";
import { OpenAICompatibleCustomProvider } from "../adapters/openai-compatible/index.js";
import { CerebrasProvider } from "../adapters/cerebras/index.js";
import { GitHubModelsProvider } from "../adapters/github/index.js";
import { NvidiaProvider } from "../adapters/nvidia/index.js";
import { CloudflareProvider } from "../adapters/cloudflare/index.js";
import { CohereProvider } from "../adapters/cohere/index.js";
import { ZhipuProvider } from "../adapters/zhipu/index.js";
import { HuggingFaceProvider } from "../adapters/huggingface/index.js";
import { CATALOG, findModel } from "./catalog.js";
import { CircuitBreaker } from "../utils/reliability.js";
import { FailureKind } from "../interfaces/Provider.js";

/**
 * Provider Registry — the router's view of the world.
 *
 * Owns every adapter instance plus its live operational state: a circuit
 * breaker (health + cooldown), rolling latency, and success/failure counters.
 * Exposes a single canonical `status` per provider that the frontend renders.
 *
 * To add a provider: create the adapter folder and add one line to ADAPTERS.
 */
const ADAPTERS = [
  GeminiProvider,
  OpenAIProvider,
  ClaudeProvider,
  DeepSeekProvider,
  KimiProvider,
  QwenProvider,
  GroqProvider,
  MistralProvider,
  OpenRouterProvider,
  OllamaProvider,
  OpenAICompatibleCustomProvider,
  // ---- free-tier providers (Phase 6) ----
  CerebrasProvider,
  GitHubModelsProvider,
  NvidiaProvider,
  CloudflareProvider,
  CohereProvider,
  ZhipuProvider,
  HuggingFaceProvider,
];

/** Canonical statuses the UI knows how to render. */
export const Status = {
  READY: "ready",
  OFFLINE: "offline",
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota_reached",
  UNCONFIGURED: "unconfigured",
};

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.state = new Map();

    for (const Adapter of ADAPTERS) {
      const provider = new Adapter();
      this.providers.set(provider.id, provider);
      this.state.set(provider.id, {
        breaker: new CircuitBreaker({ failureThreshold: 3 }),
        latencySamples: [],
        calls: 0,
        failures: 0,
        lastError: null,
        lastCheckedAt: null,
      });
    }
  }

  get(providerId) {
    return this.providers.get(providerId);
  }

  /** Provider that serves a given model id. */
  forModel(modelId) {
    const model = findModel(modelId);
    return model ? this.providers.get(model.provider) : null;
  }

  /** Available = configured and the breaker allows a request through. */
  isAvailable(providerId) {
    const provider = this.providers.get(providerId);
    const state = this.state.get(providerId);
    if (!provider?.isConfigured) return false;
    return state.breaker.allowsRequest();
  }

  /** 0..1 health score used by the router's ranking. */
  health(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider?.isConfigured) return 0;
    return this.state.get(providerId).breaker.health;
  }

  averageLatency(id) {
    const samples = this.state.get(id)?.latencySamples ?? [];
    if (!samples.length) return null;
    return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  }

  recordSuccess(providerId, latencyMs) {
    const state = this.state.get(providerId);
    if (!state) return;
    state.breaker.onSuccess();
    state.lastError = null;
    state.calls += 1;
    state.latencySamples = [...state.latencySamples, latencyMs].slice(-20);
    state.lastCheckedAt = Date.now();
  }

  recordFailure(providerId, error) {
    const state = this.state.get(providerId);
    if (!state) return;
    const kind = error?.kind || FailureKind.API_ERROR;
    state.breaker.onFailure(kind);
    state.failures += 1;
    state.lastError = { kind, message: error?.message };
    state.lastCheckedAt = Date.now();
  }

  /** Map breaker state + last failure into a status the UI understands. */
  statusOf(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider?.isConfigured) return Status.UNCONFIGURED;
    const { breaker } = this.state.get(providerId);
    const snap = breaker.snapshot();
    if (snap.state === "open") {
      if (snap.lastKind === FailureKind.QUOTA) return Status.QUOTA;
      if (snap.lastKind === FailureKind.RATE_LIMIT) return Status.RATE_LIMITED;
      return Status.OFFLINE;
    }
    return Status.READY;
  }

  /** Full snapshot for `/api/providers`. Never leaks keys or base URLs. */
  snapshot() {
    return [...this.providers.values()].map((provider) => {
      const state = this.state.get(provider.id);
      const breaker = state.breaker.snapshot();
      return {
        id: provider.id,
        name: provider.name,
        configured: provider.isConfigured,
        available: this.isAvailable(provider.id),
        status: this.statusOf(provider.id),
        health: breaker.health,
        circuit: breaker.state,
        cooldownRemainingMs: breaker.cooldownRemainingMs,
        latencyMs: this.averageLatency(provider.id),
        calls: state.calls,
        failures: state.failures,
        lastError: state.lastError,
        capabilities: provider.capabilities(),
        models: provider.models.map((m) => m.id),
      };
    });
  }

  /** Catalog enriched with live availability + status, for the model picker. */
  catalogWithStatus() {
    return CATALOG.map((model) => {
      const provider = this.providers.get(model.provider);
      return {
        ...model,
        providerName: provider?.name ?? model.provider,
        configured: Boolean(provider?.isConfigured),
        available: this.isAvailable(model.provider),
        status: this.statusOf(model.provider),
        latencyMs: this.averageLatency(model.provider),
      };
    });
  }

  async healthCheckAll() {
    const results = await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const health = await provider.health();
        if (health.ok) this.recordSuccess(provider.id, health.latencyMs ?? 0);
        else if (provider.isConfigured) this.recordFailure(provider.id, { kind: FailureKind.OUTAGE });
        return { id: provider.id, status: this.statusOf(provider.id), ...health };
      })
    );
    return results;
  }

  /**
   * Periodic health monitor. Configured providers currently in a non-closed
   * breaker state get re-probed so they recover automatically once healthy.
   */
  startHealthMonitor(intervalMs = 60_000) {
    if (this._monitor) return;
    this._monitor = setInterval(async () => {
      for (const provider of this.providers.values()) {
        if (!provider.isConfigured) continue;
        const { breaker } = this.state.get(provider.id);
        if (breaker.snapshot().state === "closed") continue; // only probe suspect ones
        const health = await provider.health().catch(() => ({ ok: false }));
        if (health.ok) this.recordSuccess(provider.id, health.latencyMs ?? 0);
      }
    }, intervalMs);
    this._monitor.unref?.();
  }

  stopHealthMonitor() {
    clearInterval(this._monitor);
    this._monitor = null;
  }
}

export const registry = new ProviderRegistry();
