/**
 * The LLM provider interface — the single contract every adapter implements.
 *
 * Referred to as `ProviderPort` in the architecture and as "the LLMProvider
 * interface" in planning; they are the same thing. It is named for the port it
 * fills, because the interface describes what the **domain needs**, not what a
 * provider SDK happens to offer
 * (docs/backend/02-architecture.md#why-ports-are-owned-by-the-domain).
 *
 * The load-bearing constraint this exists to satisfy:
 *
 *   > Adding a provider MUST NOT require reading or editing the router, the
 *   > context engine, the streaming layer, the API layer, or storage.
 *
 * Everything a provider knows about itself — wire format, error shape, auth
 * header, streaming framing — stops at its adapter. Nothing above ever sees it.
 *
 * ## Options
 *
 * `GenerationOptions` is a **closed set**. A provider-specific parameter MUST
 * NOT be added to it; if a provider needs one, it belongs in that adapter's own
 * configuration. The moment options become an open bag forwarded upstream,
 * callers start passing provider-specific keys and the abstraction is dead —
 * silently, because it still runs.
 *
 * ## Failure
 *
 * Every failure crossing this boundary MUST be a `ProviderError` carrying one of
 * the six `FailureKind` values. Raw SDK errors, fetch errors, and parse errors
 * MUST NOT escape an adapter — the router's retry and failover decisions are
 * made entirely from that taxonomy
 * (docs/backend/03-provider-system.md#error-taxonomy).
 *
 * A capability a provider genuinely cannot perform MUST throw
 * `UnsupportedCapabilityError`, never return an empty result: an empty return is
 * indistinguishable from a model with nothing to say, so the router would count
 * it as success and failover would never engage.
 *
 * @typedef {object} GenerationOptions
 * @property {string}  model
 * @property {number}  [temperature]
 * @property {number}  [maxTokens]
 * @property {number}  [topP]
 * @property {string[]} [stop]
 * @property {boolean} [json]
 * @property {object}  [jsonSchema]
 * @property {number}  [seed]
 * @property {AbortSignal} [signal]
 * @property {object}  [metadata]
 *
 * @typedef {object} GenerationResult
 * @property {string} text
 * @property {{promptTokens?: number, completionTokens?: number}|null} usage
 * @property {string} model
 * @property {string} [finishReason]
 *
 * @typedef {object} HealthResult
 * @property {boolean} ok
 * @property {number|null} latencyMs
 * @property {string} [error]
 *
 * @typedef {object} ProviderPort
 * @property {string} id
 * @property {string} name
 * @property {boolean} isConfigured
 * @property {() => import("../capability/CapabilitySet.js").CapabilitySet} capabilities
 * @property {() => Promise<import("../capability/ModelDescriptor.js").ModelDescriptor[]>} listModels
 * @property {() => Promise<HealthResult>} health
 * @property {(messages: object[], options: GenerationOptions) => Promise<GenerationResult>} generate
 * @property {(messages: object[], options: GenerationOptions) => AsyncIterable<object>} stream
 * @property {(images: object[], prompt: string, options: GenerationOptions) => Promise<GenerationResult>} vision
 * @property {(inputs: string[], options: GenerationOptions) => Promise<number[][]>} embeddings
 * @property {(messages: object[], tools: object[], options: GenerationOptions) => Promise<object>} toolCalling
 */

/** The capability methods every adapter is measured against. */
export const PROVIDER_CAPABILITY_METHODS = Object.freeze([
  "generate",
  "stream",
  "vision",
  "embeddings",
  "toolCalling",
]);

/** The full required surface, used by the contract suite to assert conformance. */
export const PROVIDER_INTERFACE = Object.freeze([
  ...PROVIDER_CAPABILITY_METHODS,
  "listModels",
  "health",
  "capabilities",
]);

/** Which capability axis each method requires a model to declare. */
export const METHOD_CAPABILITY = Object.freeze({
  stream: "streaming",
  vision: "vision",
  embeddings: "embeddings",
  toolCalling: "toolCalling",
});
