import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Find the adapters that exist.
 *
 * One job: answer *what providers are on disk*. It does not import them, does
 * not read credentials, and does not decide whether any of them should run —
 * those are the loader's, the config's, and the factory's jobs respectively.
 *
 * Discovery is filesystem-driven so that dropping a folder into `adapters/`
 * registers a provider. That is the mechanism behind the requirement that
 * adding a provider means "create adapter, register adapter, nothing else":
 * there is no central array to forget to edit, and therefore no way for the
 * registration step to be half-done.
 *
 * An explicit list is still accepted (`sources`), because tests need to control
 * exactly which adapters exist and scanning a real directory from a test is a
 * dependency on repository layout.
 */
export class ProviderDiscovery {
  /**
   * @param {object} [options]
   * @param {string} [options.directory] adapters root; defaults to ../adapters
   * @param {string[]} [options.sources] explicit module specifiers, bypassing the scan
   * @param {import("../../../domain/ports/LoggerPort.js").LoggerPort} [options.logger]
   */
  constructor({ directory, sources, logger } = {}) {
    this.directory =
      directory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../adapters");
    this.sources = sources ?? null;
    this.logger = logger;
  }

  /**
   * @returns {Promise<Array<{id: string, specifier: string}>>} candidates, not
   * yet imported or validated — a candidate is a claim that something is there.
   */
  async discover() {
    if (this.sources) {
      return this.sources.map((specifier) => ({
        id: path.basename(specifier, path.extname(specifier)),
        specifier,
      }));
    }

    if (!existsSync(this.directory)) {
      // Not an error. A deployment may legitimately run with no adapters — the
      // platform still serves health and metrics.
      this.logger?.warn("providers.discovery.no_directory", { directory: this.directory });
      return [];
    }

    const entries = await readdir(this.directory, { withFileTypes: true });
    const candidates = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(this.directory, entry.name, "index.js");
      if (!existsSync(indexPath)) {
        // A directory without an entry point is a mistake worth naming: it is
        // almost always a half-finished adapter that would otherwise be
        // silently absent.
        this.logger?.warn("providers.discovery.missing_entrypoint", { adapter: entry.name });
        continue;
      }
      candidates.push({ id: entry.name, specifier: indexPath });
    }

    this.logger?.debug("providers.discovery.completed", {
      directory: this.directory,
      found: candidates.map((c) => c.id),
    });

    return candidates;
  }
}
