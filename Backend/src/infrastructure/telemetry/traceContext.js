import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient request correlation.
 *
 * The trace id must reach every log line, every metric exemplar, and every
 * error response. Threading it explicitly through every function signature
 * would put an observability concern into the type of every domain function —
 * so it rides in async local storage instead, which survives `await` boundaries
 * without touching call signatures (docs/backend/11-observability.md#correlation).
 *
 * The `LoggerPort` interface stays unaware of this: the logger reads the store
 * if one is active and carries on if not, so a logger used outside a request
 * (at boot, in a background job, in a unit test) still works.
 */

/** @typedef {{ traceId: string, requestId: string, correlationId: string, userId?: string, threadId?: string }} RequestContext */

const storage = new AsyncLocalStorage();

/** Run `fn` with `context` visible to everything it awaits. */
export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

/** The active context, or undefined outside a request. */
export function currentContext() {
  return storage.getStore();
}

/** Correlation fields for a log line. Empty outside a request. */
export function contextFields() {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const fields = {
    traceId: ctx.traceId,
    requestId: ctx.requestId,
  };
  // Only emitted when it differs, so the common case stays uncluttered.
  if (ctx.correlationId && ctx.correlationId !== ctx.traceId) {
    fields.correlationId = ctx.correlationId;
  }
  if (ctx.userId) fields.userId = ctx.userId;
  if (ctx.threadId) fields.threadId = ctx.threadId;
  return fields;
}

/**
 * Attach a field to the active context.
 * Used by authentication to add `userId` once it is known, so every subsequent
 * log line in the request carries it without being passed it.
 */
export function enrichContext(fields) {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, fields);
}
