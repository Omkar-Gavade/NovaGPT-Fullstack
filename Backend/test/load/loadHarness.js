import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * A load generator, sized for what actually breaks this system.
 *
 * **Memory is the metric that matters, not throughput.** Every active stream
 * holds a buffer, a reader and an open socket. A leak invisible at 10
 * concurrent streams is an out-of-memory kill at 200, and the crash looks
 * unrelated to its cause (docs/backend/12-testing.md#load-testing).
 *
 * Written here rather than pulled in as k6 or autocannon for two reasons: the
 * scenarios need SSE-aware clients that count *frames* rather than bytes, and
 * the assertions are about the server process's heap, which an external tool
 * cannot see. Throughput numbers from a load tool running on the same laptop as
 * the server are noise anyway.
 */

/** Heap and event-loop lag, sampled while load runs. */
export class ProcessObserver {
  constructor({ intervalMs = 250 } = {}) {
    this.intervalMs = intervalMs;
    this.samples = [];
    this.lag = monitorEventLoopDelay({ resolution: 10 });
    this.timer = null;
  }

  start() {
    this.lag.enable();
    this.timer = setInterval(() => {
      this.samples.push({
        at: Date.now(),
        heapUsed: process.memoryUsage().heapUsed,
        rss: process.memoryUsage().rss,
      });
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.lag.disable();
    return this.report();
  }

  report() {
    const heap = this.samples.map((s) => s.heapUsed);
    const half = Math.floor(heap.length / 2);

    // **The floor of each half, not the mean.**
    //
    // A healthy heap under load is a sawtooth: allocation climbs, a garbage
    // collection drops it, repeat. The *peaks* are allocation rate and move
    // with wherever GC happened to land in the sampling window — comparing
    // means made this assertion flap between 1.4x and 1.8x on identical code.
    // The *troughs* are retained memory, and only a leak raises them.
    //
    // Mean-based comparison had exactly the wrong property here: it was noisy
    // enough to demand a threshold loose enough to miss a real leak.
    const floor = (values) => Math.min(...values);
    const firstFloor = floor(heap.slice(0, half));
    const secondFloor = floor(heap.slice(half));

    return {
      samples: heap.length,
      heapFloorStartMb: +(firstFloor / 1024 / 1024).toFixed(1),
      heapFloorEndMb: +(secondFloor / 1024 / 1024).toFixed(1),
      heapPeakMb: +(Math.max(...heap) / 1024 / 1024).toFixed(1),
      // > 1 means retained memory is still climbing once the workload is in
      // steady state, which is what a leak looks like before it looks like a
      // crash.
      heapGrowthRatio: firstFloor > 0 ? +(secondFloor / firstFloor).toFixed(3) : 1,
      peakRssMb: +(Math.max(...this.samples.map((s) => s.rss)) / 1024 / 1024).toFixed(1),
      eventLoopLagP99Ms: +(this.lag.percentile(99) / 1e6).toFixed(1),
      eventLoopLagMaxMs: +(this.lag.max / 1e6).toFixed(1),
    };
  }
}

/**
 * Run `worker` at a fixed concurrency for a duration.
 *
 * Fixed concurrency rather than a fixed rate: this system's cost is *open
 * streams*, and an arrival-rate model would let the queue grow without bound
 * and measure the queue instead of the server.
 */
export async function sustain({ concurrency, durationMs, worker, clock = Date }) {
  const deadline = clock.now() + durationMs;
  const stats = { started: 0, completed: 0, failed: 0, errors: new Map(), latencies: [] };

  const lane = async () => {
    while (clock.now() < deadline) {
      stats.started += 1;
      const began = clock.now();
      try {
        await worker();
        stats.completed += 1;
        stats.latencies.push(clock.now() - began);
      } catch (error) {
        stats.failed += 1;
        const key = error?.kind ?? error?.message ?? "unknown";
        stats.errors.set(key, (stats.errors.get(key) ?? 0) + 1);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, lane));
  return summarise(stats);
}

/** Fire `count` requests at once, with no pacing at all. */
export async function burst({ count, worker }) {
  const stats = { started: count, completed: 0, failed: 0, errors: new Map(), latencies: [] };

  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      const began = Date.now();
      const value = await worker();
      stats.latencies.push(Date.now() - began);
      return value;
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") stats.completed += 1;
    else {
      stats.failed += 1;
      const key = result.reason?.kind ?? result.reason?.message ?? "unknown";
      stats.errors.set(key, (stats.errors.get(key) ?? 0) + 1);
    }
  }

  return summarise(stats);
}

function summarise(stats) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

  return {
    started: stats.started,
    completed: stats.completed,
    failed: stats.failed,
    errors: Object.fromEntries(stats.errors),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
  };
}
