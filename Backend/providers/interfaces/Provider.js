/**
 * Provider contract (Strategy pattern).
 *
 * Every provider adapter extends this class and implements the surface below.
 * The router only ever talks to this interface — no provider-specific logic
 * lives anywhere else in the app, so adding a provider means adding one folder.
 *
 * Capability methods that a provider genuinely cannot do should throw
 * `UnsupportedCapabilityError` rather than silently returning empty output.
 */

export class UnsupportedCapabilityError extends Error {
  constructor(provider, capability) {
    super(`${provider} does not support ${capability}()`);
    this.name = "UnsupportedCapabilityError";
    this.code = "UNSUPPORTED_CAPABILITY";
  }
}

/** Normalized failure reasons the router uses to decide on failover. */
export const FailureKind = {
  QUOTA: "quota",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  OUTAGE: "outage",
  API_ERROR: "api_error",
  AUTH: "auth",
};

export class ProviderError extends Error {
  constructor(message, kind = FailureKind.API_ERROR, { status, provider, retryAfter } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.provider = provider;
    this.retryAfter = retryAfter;
  }

  /** True when trying a different provider is likely to help. */
  get isFailoverWorthy() {
    return [
      FailureKind.QUOTA,
      FailureKind.RATE_LIMIT,
      FailureKind.TIMEOUT,
      FailureKind.OUTAGE,
    ].includes(this.kind);
  }
}

export class Provider {
  /**
   * @param {object} config
   * @param {string} config.id        stable provider id, e.g. "gemini"
   * @param {string} config.name      display name
   * @param {string} [config.apiKey]  credential, if the provider needs one
   * @param {string} [config.baseURL] endpoint override
   * @param {object[]} [config.models] catalog entries this provider serves
   */
  constructor(config = {}) {
    if (new.target === Provider) {
      throw new Error("Provider is abstract — extend it with an adapter");
    }
    this.id = config.id;
    this.name = config.name;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
    this.models = config.models || [];
  }

  /** Whether this provider is configured well enough to be used at all. */
  get isConfigured() {
    return Boolean(this.apiKey);
  }

  /** One-shot completion. Returns { text, usage, model }. */
  // eslint-disable-next-line no-unused-vars
  async generate(messages, options = {}) {
    throw new UnsupportedCapabilityError(this.id, "generate");
  }

  /** Async generator yielding text deltas. */
  // eslint-disable-next-line no-unused-vars, require-yield
  async *stream(messages, options = {}) {
    throw new UnsupportedCapabilityError(this.id, "stream");
  }

  /** Multimodal completion over images + prompt. */
  // eslint-disable-next-line no-unused-vars
  async vision(images, prompt, options = {}) {
    throw new UnsupportedCapabilityError(this.id, "vision");
  }

  /** Vector embeddings for an array of strings. */
  // eslint-disable-next-line no-unused-vars
  async embeddings(inputs, options = {}) {
    throw new UnsupportedCapabilityError(this.id, "embeddings");
  }

  /** Completion with tool/function definitions. */
  // eslint-disable-next-line no-unused-vars
  async toolCalling(messages, tools, options = {}) {
    throw new UnsupportedCapabilityError(this.id, "toolCalling");
  }

  /** Models this provider can serve right now. */
  async listModels() {
    return this.models;
  }

  /** Liveness probe. Returns { ok, latencyMs, error? }. */
  async health() {
    if (!this.isConfigured) {
      return { ok: false, latencyMs: null, error: "Not configured" };
    }
    const started = Date.now();
    try {
      await this.listModels();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  }

  /* --------------------------- capability flags ---------------------------
   * Derived from the provider's catalog so a provider never lies about what it
   * can do. Adapters may override, but the data-driven default is usually right.
   */

  /** Every adapter here implements stream(); override to false if it can't. */
  supportsStreaming() {
    return true;
  }

  supportsVision() {
    return this.models.some((m) => m.vision);
  }

  supportsTools() {
    return this.models.some((m) => m.tools);
  }

  /** Reasoning-grade if any served model scores highly on the reasoning axis. */
  supportsReasoning() {
    return this.models.some((m) => (m.reasoning ?? 0) >= 85);
  }

  /** Structured / JSON output. Override to false if the API can't do it. */
  supportsJson() {
    return true;
  }

  /** Vector embeddings. Off unless the adapter wires an embedding model. */
  supportsEmbeddings() {
    return false;
  }

  /** All capability flags at once, for the registry snapshot. */
  capabilities() {
    return {
      streaming: this.supportsStreaming(),
      vision: this.supportsVision(),
      tools: this.supportsTools(),
      reasoning: this.supportsReasoning(),
      json: this.supportsJson(),
      embeddings: this.supportsEmbeddings(),
    };
  }
}
