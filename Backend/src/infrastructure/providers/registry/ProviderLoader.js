import { pathToFileURL } from "node:url";
import { ProviderDescriptor } from "../../../domain/provider/ProviderDescriptor.js";

/**
 * Import a discovered adapter and validate its exports.
 *
 * One job: turn a candidate into a `{ descriptor, Adapter }` pair, or explain
 * why it cannot. It does not construct anything — that needs credentials and
 * configuration, which is the factory's concern.
 *
 * A loader failure is **isolated**. One broken adapter must not stop the other
 * seven from loading: a syntax error in an experimental provider would
 * otherwise take down a platform that was perfectly capable of running without
 * it. Failures are collected and reported, never thrown upward.
 *
 * ## The adapter contract
 *
 * Every adapter module MUST export:
 *   `descriptor` — a ProviderDescriptor, or a plain object accepted by it
 *   `Adapter`    — a class extending BaseProvider (also accepted: `default`)
 */
export class ProviderLoader {
  constructor({ logger } = {}) {
    this.logger = logger;
  }

  /**
   * @param {Array<{id: string, specifier: string}>} candidates
   * @returns {Promise<{loaded: Array<object>, failed: Array<object>}>}
   */
  async loadAll(candidates) {
    const loaded = [];
    const failed = [];

    // Sequential rather than parallel. Module loading is fast, and a
    // deterministic order makes registration order — and therefore any
    // order-dependent bug — reproducible.
    for (const candidate of candidates) {
      try {
        loaded.push(await this.load(candidate));
      } catch (error) {
        failed.push({ id: candidate.id, error });
        this.logger?.error("providers.load.failed", { adapter: candidate.id, error });
      }
    }

    return { loaded, failed };
  }

  /** @returns {Promise<{descriptor: ProviderDescriptor, Adapter: Function}>} */
  async load({ id, specifier }) {
    const url = specifier.startsWith(".") || specifier.includes("://")
      ? specifier
      : pathToFileURL(specifier).href;

    const module = await import(url);
    const Adapter = module.Adapter ?? module.default;

    if (typeof Adapter !== "function") {
      throw new TypeError(
        `Adapter "${id}" must export an \`Adapter\` class (or a default export)`
      );
    }
    if (!module.descriptor) {
      throw new TypeError(`Adapter "${id}" must export a \`descriptor\``);
    }

    const descriptor =
      module.descriptor instanceof ProviderDescriptor
        ? module.descriptor
        : new ProviderDescriptor(module.descriptor);

    // The folder name and the declared id disagreeing is the kind of mismatch
    // that produces a provider nobody can enable by config, because the config
    // key and the discovered key differ.
    if (descriptor.id !== id) {
      throw new TypeError(
        `Adapter directory "${id}" declares provider id "${descriptor.id}" — they must match`
      );
    }

    this.logger?.debug("providers.load.succeeded", {
      adapter: descriptor.id,
      adapterVersion: descriptor.adapterVersion,
      models: descriptor.models.length,
    });

    return { descriptor, Adapter };
  }
}
