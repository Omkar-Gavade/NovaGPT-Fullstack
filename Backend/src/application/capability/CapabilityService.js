import { AppError, ErrorKind } from "../../domain/errors/index.js";

/**
 * The two capability endpoints that are not chat: tool calling and embeddings.
 *
 * Both go through the **same router and the same executor** as chat, which is
 * the point — they inherit ranking, failover, retry, the breaker and usage
 * accounting for free. An endpoint that called a provider directly would be a
 * second, weaker copy of all of that, and it is exactly how a system ends up
 * with one path that fails over and one that does not.
 *
 * They are separate from `ChatOrchestrator` because neither is a conversation:
 * there is no thread to load, no context to assemble, and nothing to persist.
 * Forcing them through the chat sequence would mean four `if` branches in a
 * class whose whole value is that it has one order of operations.
 */
export class CapabilityService {
  constructor({ routingService, routingExecutor, logger, metrics }) {
    this.routingService = routingService;
    this.routingExecutor = routingExecutor;
    this.logger = logger?.child?.({ component: "capability" }) ?? logger;
    this.metrics = metrics;
  }

  /**
   * Ask a model which tools it would call.
   *
   * **Returns intent, never results.** Executing a tool is a trust and
   * sandboxing problem of a different kind and is out of scope; the client
   * decides whether to act (docs/backend/14-roadmap.md).
   */
  async callTools({ messages, tools, model = null, settings = {}, credentials, signal }) {
    if (!tools?.length) {
      throw new AppError("At least one tool is required.", ErrorKind.VALIDATION, { field: "tools" });
    }

    const { decision } = this.routingService.route({
      model,
      tools,
      maxTokens: settings.maxTokens,
    });

    const outcome = await this.routingExecutor.execute({
      decision,
      signal,
      options: { temperature: settings.temperature, maxTokens: settings.maxTokens },
      invoke: (provider, chosen, options) =>
        provider.toolCalling(messages, tools, {
          ...withCredential(options, credentials, provider),
          model: chosen.id,
        }),
      userKeyProviders: new Set(credentials?.keys() ?? []),
    });

    return {
      text: outcome.result.text ?? "",
      toolCalls: outcome.result.toolCalls ?? [],
      model: outcome.model,
      usage: outcome.result.usage,
      switched: outcome.switched,
    };
  }

  /**
   * Embed a batch of strings.
   *
   * Batched at the API rather than per string: embedding a hundred strings one
   * request at a time is a hundred round trips and a hundred chances to hit a
   * rate limit, for work every provider accepts in one call.
   */
  async embed({ inputs, model = null, credentials, signal }) {
    const { decision } = this.routingService.route({ model, embeddings: true });

    const outcome = await this.routingExecutor.execute({
      decision,
      signal,
      options: {},
      invoke: (provider, chosen, options) =>
        provider.embeddings(inputs, {
          ...withCredential(options, credentials, provider),
          model: chosen.id,
        }),
      userKeyProviders: new Set(credentials?.keys() ?? []),
    });

    const vectors = outcome.result;
    return {
      embeddings: vectors,
      model: outcome.model,
      // The dimension count, so a caller storing these in a vector index knows
      // the shape before it writes the first row — and so a model change that
      // silently alters it is visible rather than discovered at query time.
      dimensions: vectors[0]?.length ?? 0,
      switched: outcome.switched,
    };
  }
}

/** The user's own key for this provider, when they have one. */
function withCredential(options, credentials, provider) {
  const credential = credentials?.get(provider.id);
  return credential ? { ...options, credential } : options;
}
