import {
  Adapter,
  descriptor as rawDescriptor,
} from "../../src/infrastructure/providers/adapters/mock/index.js";
import { ProviderDescriptor } from "../../src/domain/provider/ProviderDescriptor.js";
import { ModelDescriptor } from "../../src/domain/capability/ModelDescriptor.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { FakeClock } from "../../src/infrastructure/system/SystemClock.js";
import { silentLogger } from "../../src/infrastructure/telemetry/Logger.js";

/**
 * Build a mock provider directly, bypassing discovery and the factory.
 *
 * Lives in `helpers/` rather than beside the contract test because importing a
 * *test* module for its exports re-registers that module's tests inside
 * whatever test does the importing — they then run nested, and node:test
 * cancels them when the parent finishes.
 */

export const mockDescriptor = new ProviderDescriptor(rawDescriptor);

export function buildMockProvider(settings = {}, { clock = new FakeClock(0) } = {}) {
  return new Adapter({
    descriptor: mockDescriptor,
    models: mockDescriptor.models.map(
      (m) => new ModelDescriptor({ ...m, provider: mockDescriptor.id })
    ),
    logger: silentLogger,
    clock,
    credential: new Secret("mock-enabled", "MOCK_PROVIDER_ENABLED"),
    settings,
  });
}
