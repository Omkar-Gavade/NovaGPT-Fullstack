import { UnsupportedCapabilityError } from "../../../domain/errors/ProviderError.js";
import { CapabilitySet } from "../../../domain/capability/CapabilitySet.js";
import { METHOD_CAPABILITY } from "../../../domain/ports/ProviderPort.js";

/**
 * Abstract base implementing `ProviderPort`.
 *
 * Every capability method defaults to throwing `UnsupportedCapabilityError`.
 * That default is what makes the interface cheap to extend: a new capability
 * can be added to the port and implemented by one adapter, with every other
 * adapter *correctly* reporting it cannot do it, in a single small change — no
 * migration, no coordination (docs/backend/03-provider-system.md#versioning).
 *
 * Capabilities are **derived from the provider's models**, not declared by the
 * adapter. A provider supports vision when one of its models does. This is why
 * an adapter cannot lie by omission: the answer comes from the catalog, which
 * is reviewed data rather than a hand-maintained boolean.
 */
export class BaseProvider {
  /**
   * @param {object} config
   * @param {import("../../../domain/provider/ProviderDescriptor.js").ProviderDescriptor} config.descriptor
   * @param {import("../../../domain/capability/ModelDescriptor.js").ModelDescriptor[]} [config.models]
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} [config.logger]
   * @param {import("../../../domain/ports/ClockPort.js").ClockPort} [config.clock]
   * @param {import("../../telemetry/Secret.js").Secret} [config.credential]
   * @param {object} [config.settings] adapter-specific configuration
   */
  constructor({ descriptor, models = [], logger, clock, credential = null, settings = {} } = {}) {
    if (new.target === BaseProvider) {
      throw new TypeError("BaseProvider is abstract — extend it with an adapter");
    }
    if (!descriptor) throw new TypeError("A provider needs a descriptor");

    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.models = models;
    this.logger = logger?.child?.({ provider: descriptor.id }) ?? logger;
    this.clock = clock;
    this.credential = credential;
    this.settings = Object.freeze({ ...settings });
  }

  /**
   * Whether this provider has what it needs to be used at all.
   * An unconfigured provider is skipped by the router — not an error, and not
   * something the user should ever see mentioned.
   */
  get isConfigured() {
    return this.descriptor.requiresCredentials ? Boolean(this.credential) : true;
  }

  /**
   * The union of its models' capabilities.
   *
   * Provider-level capability is a *derived* view. Attaching capabilities to a
   * provider directly would force the router to either over-promise (route
   * text-only work to a vision model) or under-promise (never use it), because
   * one provider routinely serves models with different capabilities
   * (docs/backend/05-capability-matrix.md#design-principles).
   */
  capabilities() {
    const union = {};
    for (const model of this.models) {
      for (const name of model.capabilities.supported()) union[name] = true;
    }
    return new CapabilitySet(union);
  }

  supports(capability) {
    return this.models.some((m) => m.supports(capability));
  }

  /** Models this provider can serve right now. Adapters may live-probe. */
  async listModels() {
    return this.models;
  }

  /**
   * Liveness probe.
   *
   * The default proves the adapter is constructible and its catalog resolvable.
   * A real adapter overrides it with the cheapest call that proves the endpoint
   * answers — never a completion, which on a free tier spends a request a user
   * could have had (docs/backend/03-provider-system.md#health-system).
   */
  async health() {
    if (!this.isConfigured) {
      return { ok: false, latencyMs: null, error: "not configured" };
    }
    const started = this.clock?.now() ?? Date.now();
    try {
      await this.listModels();
      return { ok: true, latencyMs: (this.clock?.now() ?? Date.now()) - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: (this.clock?.now() ?? Date.now()) - started,
        error: error.message,
      };
    }
  }

  /* ---------------------------- capability methods ----------------------- *
   * Each throws rather than returning empty. An empty return is
   * indistinguishable from a model that had nothing to say, so the router would
   * count it as success and the failover machinery would never engage.
   * -------------------------------------------------------------------------- */

  // eslint-disable-next-line no-unused-vars
  async generate(messages, options = {}) {
    throw this.unsupported("generate");
  }

  // eslint-disable-next-line no-unused-vars, require-yield
  async *stream(messages, options = {}) {
    throw this.unsupported("stream");
  }

  // eslint-disable-next-line no-unused-vars
  async vision(images, prompt, options = {}) {
    throw this.unsupported("vision");
  }

  // eslint-disable-next-line no-unused-vars
  async embeddings(inputs, options = {}) {
    throw this.unsupported("embeddings");
  }

  // eslint-disable-next-line no-unused-vars
  async toolCalling(messages, tools, options = {}) {
    throw this.unsupported("toolCalling");
  }

  /** @protected */
  unsupported(capability) {
    return new UnsupportedCapabilityError(this.id, capability);
  }

  /**
   * Guard for an adapter that implements a method but whose catalog says the
   * selected model cannot do it.
   *
   * @protected
   */
  assertSupported(method, modelId) {
    // Model existence is checked for *every* method, including ones with no
    // capability requirement. Skipping the check when a method needs no
    // capability is how an unknown model id reaches the provider and comes
    // back as an opaque upstream 404 — a typed error here names the actual
    // problem at the boundary that can still see it.
    const model = this.models.find((m) => m.id === modelId);
    if (!model) throw this.unsupported(`${method} (unknown model "${modelId}")`);

    const capability = METHOD_CAPABILITY[method];
    if (capability && !model.supports(capability)) throw this.unsupported(method);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      dialect: this.descriptor.dialect,
      adapterVersion: this.descriptor.adapterVersion,
      configured: this.isConfigured,
      models: this.models.map((m) => m.id),
      capabilities: this.capabilities().toJSON(),
    };
  }
}
