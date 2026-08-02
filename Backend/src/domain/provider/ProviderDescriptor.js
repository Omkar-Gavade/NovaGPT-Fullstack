/**
 * A provider's manifest — its identity, before any instance exists.
 *
 * This is what discovery finds and what the loader and factory consume. It is
 * pure data: no credentials, no client, no network. Keeping identity separate
 * from the live instance is what lets the system report "eight providers exist,
 * three are configured" without constructing anything.
 *
 * Every adapter ships one of these next to its implementation, so registering a
 * provider means adding a folder rather than editing a central list.
 */
export class ProviderDescriptor {
  /**
   * @param {object} raw
   * @param {string} raw.id            stable identifier, e.g. "groq"
   * @param {string} raw.name          display name
   * @param {string} [raw.dialect]     wire dialect, e.g. "openai" | "native" | "mock"
   * @param {string} [raw.adapterVersion] semver of this adapter's behaviour
   * @param {string[]} [raw.envKeys]   credential variables, first match wins
   * @param {boolean} [raw.requiresCredentials]
   * @param {object[]} [raw.models]    catalog rows this provider serves
   * @param {boolean} [raw.experimental] ship-dark flag: loaded but ranked last
   */
  constructor(raw = {}) {
    const problems = [];
    if (!raw.id || typeof raw.id !== "string") problems.push("id is required");
    if (raw.id && !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
      // The id appears in metric labels, config keys, and log fields. Enforcing
      // a narrow charset here avoids an adapter deciding to call itself
      // "My Provider!" and quietly breaking a Prometheus label.
      problems.push(`id "${raw.id}" must be lowercase alphanumeric with hyphens`);
    }
    if (!raw.name) problems.push("name is required");
    if (raw.models && !Array.isArray(raw.models)) problems.push("models must be an array");
    if (problems.length) {
      throw new TypeError(`Invalid provider descriptor: ${problems.join("; ")}`);
    }

    this.id = raw.id;
    this.name = raw.name;
    this.dialect = raw.dialect ?? "native";
    this.adapterVersion = raw.adapterVersion ?? "0.1.0";
    this.envKeys = Object.freeze([...(raw.envKeys ?? [])]);
    // Defaults to true: assuming a provider needs no credentials would let an
    // unconfigured provider be selected and fail at request time.
    this.requiresCredentials = raw.requiresCredentials !== false;
    this.models = Object.freeze([...(raw.models ?? [])]);
    this.experimental = raw.experimental === true;
    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      dialect: this.dialect,
      adapterVersion: this.adapterVersion,
      requiresCredentials: this.requiresCredentials,
      experimental: this.experimental,
      modelCount: this.models.length,
    };
  }
}
