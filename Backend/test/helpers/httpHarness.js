import { createApp } from "../../src/interfaces/http/createApp.js";
import { CheckLiveness } from "../../src/application/health/CheckLiveness.js";
import { CheckReadiness } from "../../src/application/health/CheckReadiness.js";
import { GetVersion } from "../../src/application/health/GetVersion.js";
import { ServiceState } from "../../src/domain/lifecycle/ServiceState.js";
import { SystemClock } from "../../src/infrastructure/system/SystemClock.js";
import { Metrics } from "../../src/infrastructure/telemetry/Metrics.js";
import { testConfig, recordingLogger, fakeProbe } from "./testDoubles.js";

/**
 * Start the real HTTP stack on an ephemeral port with fake dependencies.
 *
 * Real Express, real middleware chain, real error handler — only the driven
 * adapters are doubles. That boundary is deliberate: the middleware ordering
 * and the error envelope are exactly the things a unit test cannot verify
 * (docs/backend/12-testing.md#integration-testing).
 *
 * Requests go over a real socket via `fetch` rather than through a
 * request-injection library, so header handling, status codes, and connection
 * behaviour are the ones a client would actually see.
 */
export async function startTestServer({ probes, config: overrides, state: providedState } = {}) {
  const clock = new SystemClock();
  const logger = recordingLogger("debug");
  const config = testConfig(overrides);
  const metrics = new Metrics({ collectDefaults: false, logger });

  const state = providedState ?? new ServiceState(clock.now());
  if (!providedState) state.markReady();

  const dependencies = probes ?? [
    fakeProbe({ name: "mongodb", critical: true, ok: true }),
    fakeProbe({ name: "cache", critical: false, ok: true }),
  ];

  const useCases = {
    checkLiveness: new CheckLiveness({ state, clock }),
    checkReadiness: new CheckReadiness({ state, probes: dependencies, clock, metrics }),
    getVersion: new GetVersion({
      service: config.service,
      state,
      clock,
      environment: config.env,
      runtime: `node ${process.versions.node}`,
    }),
  };

  const app = createApp({ config, logger, metrics, clock, useCases });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    server,
    state,
    logger,
    metrics,
    config,
    get: (path, init) => fetch(`${base}${path}`, init),
    async json(path, init) {
      const response = await fetch(`${base}${path}`, init);
      return { response, body: await response.json() };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.close(resolve);
      }),
  };
}
