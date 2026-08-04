/**
 * The caller went away.
 *
 * Deliberately **not** a `ProviderError`, and never recorded as a provider
 * failure. The provider did nothing wrong; counting a cancellation against it
 * would open a breaker on a healthy provider, so a user who cancels three long
 * generations in a row would take that provider out of rotation for everyone
 * (docs/backend/07-streaming-engine.md#cancellation).
 *
 * Lives in the domain because both the application layer (which must not fail
 * over on it) and infrastructure (which raises it) need to recognise it, and
 * neither may import the other.
 */
export class CancelledError extends Error {
  constructor(message = "Request cancelled") {
    super(message);
    this.name = "CancelledError";
    this.cancelled = true;
  }

  static is(value) {
    return value instanceof CancelledError || value?.cancelled === true;
  }
}

/**
 * Our own attempt budget elapsed, as opposed to the caller cancelling.
 *
 * Kept distinct from `CancelledError` because the two lead to opposite
 * decisions: a deadline is a provider `timeout` worth failing over, a
 * cancellation is not worth anything at all.
 */
export class DeadlineError extends Error {
  constructor(budgetMs) {
    super(`Attempt exceeded ${budgetMs}ms`);
    this.name = "DeadlineError";
    this.budgetMs = budgetMs;
  }
}
