/**
 * The real clock, implementing ClockPort.
 *
 * Trivial by design. Its whole purpose is to be the one place that touches
 * `Date.now()`, so that everything above it can be handed a fake instead and
 * test a 15-minute cooldown in a microsecond.
 */
export class SystemClock {
  now() {
    return Date.now();
  }

  date() {
    return new Date();
  }

  /** Rejects with an AbortError if the signal fires first. */
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true }
      );
    });
  }
}

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Controllable clock for tests.
 *
 * Lives beside the real one rather than in the test tree because it is part of
 * the port's contract: a port without a usable fake is a port that will be
 * mocked ad hoc in every test file.
 */
export class FakeClock {
  constructor(startMs = 0) {
    this.current = startMs;
  }

  now() {
    return this.current;
  }

  date() {
    return new Date(this.current);
  }

  /** Advances time rather than waiting. */
  async sleep(ms) {
    this.current += ms;
  }

  advance(ms) {
    this.current += ms;
    return this.current;
  }
}
