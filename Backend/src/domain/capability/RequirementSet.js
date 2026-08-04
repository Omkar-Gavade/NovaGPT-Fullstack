import { CapabilityKind } from "./Capability.js";
import { capabilityRegistry } from "./CapabilityRegistry.js";

/**
 * What a request needs from a model.
 *
 * Only filterable axes may appear here. A scored axis is rejected at
 * construction: the scores are maintainer estimates, not a calibrated scale, so
 * using one as a gate ("reasoning >= 85") produces confidently wrong exclusions.
 * Scores rank; they never filter
 * (docs/backend/05-capability-matrix.md#scored-capabilities--ranking-only).
 *
 * Requirements are **derived** from the request, never declared by the client
 * (docs/backend/05-capability-matrix.md#requirements-are-derived-not-declared).
 * A client cannot forget a requirement it did not know existed, and cannot
 * over-declare and needlessly shrink the candidate set. The derivation lives in
 * `RequirementSet.from`, in one place, unit-testable.
 */
export class RequirementSet {
  constructor(required = {}, registry = capabilityRegistry) {
    const problems = [];
    for (const [name, value] of Object.entries(required)) {
      if (!registry.has(name)) {
        problems.push(`unknown capability "${name}"`);
      } else if (!registry.isFilterable(name)) {
        problems.push(`"${name}" is a scored axis and cannot be a requirement`);
      } else if (registry.kindOf(name) === CapabilityKind.BINARY && value !== true) {
        problems.push(`"${name}" must be required as true, not ${JSON.stringify(value)}`);
      } else if (registry.kindOf(name) === CapabilityKind.NUMERIC && !(value > 0)) {
        problems.push(`"${name}" must be a positive minimum`);
      }
    }
    if (problems.length) throw new TypeError(`Invalid requirements: ${problems.join("; ")}`);

    this.registry = registry;
    this.required = Object.freeze({ ...required });
    Object.freeze(this);
  }

  get isEmpty() {
    return Object.keys(this.required).length === 0;
  }

  names() {
    return Object.keys(this.required);
  }

  /**
   * Does this capability set satisfy every requirement?
   * @param {import("./CapabilitySet.js").CapabilitySet} capabilities
   */
  satisfiedBy(capabilities) {
    return this.unmetBy(capabilities).length === 0;
  }

  /**
   * Which requirements are unmet, and why.
   *
   * Returning the reasons rather than a boolean is what lets the router say
   * "this conversation is too long for any available model; the largest window
   * is 256K" instead of a generic failure
   * (docs/backend/05-capability-matrix.md#errors-the-matrix-makes-possible).
   *
   * @returns {Array<{capability: string, required: unknown, actual: unknown}>}
   */
  unmetBy(capabilities) {
    const unmet = [];
    for (const [name, needed] of Object.entries(this.required)) {
      const actual = capabilities.value(name);
      if (this.registry.kindOf(name) === CapabilityKind.BINARY) {
        if (actual !== true) unmet.push({ capability: name, required: true, actual: false });
      } else if (!Number.isFinite(actual) || actual < needed) {
        unmet.push({ capability: name, required: needed, actual });
      }
    }
    return unmet;
  }

  /**
   * Derive requirements from a request shape.
   *
   * Deliberately conservative: it asks only what the request's *content*
   * proves. A request with images needs vision; nothing else may be inferred.
   */
  static from(request = {}, registry = capabilityRegistry) {
    const required = {};

    // `vision` and `pdf` may arrive already derived, from the message content
    // itself. That is the authoritative source: `type` on an attachment is the
    // *client's claim*, while `kind` is what the bytes were sniffed to be, and
    // a request must not reach a text-only model by mislabelling its own images
    // (docs/backend/10-security.md#input-validation).
    if (request.vision === true) required.vision = true;
    if (request.pdf === true) required.pdf = true;

    const attachmentIs = (value) =>
      request.attachments?.some((a) => a.kind === value || a.type === value);
    if (attachmentIs("image")) required.vision = true;
    if (attachmentIs("pdf")) required.pdf = true;
    if (request.tools?.length) required.toolCalling = true;
    // Explicit rather than inferred: an embeddings request carries no content
    // that would betray it, so nothing else could derive this.
    if (request.embeddings === true) required.embeddings = true;
    if (request.responseFormat?.type === "json") required.json = true;
    if (request.responseFormat?.type === "json_schema") required.structuredOutput = true;
    if (request.streaming === true) required.streaming = true;
    if (request.estimatedPromptTokens > 0) required.contextWindow = request.estimatedPromptTokens;
    if (request.maxTokens > 0) required.maxOutputTokens = request.maxTokens;
    return new RequirementSet(required, registry);
  }

  toJSON() {
    return { ...this.required };
  }
}
