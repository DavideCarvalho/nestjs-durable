import { describe, expect, it } from 'vitest';
import { AdaptiveController, resolveConcurrency } from './adaptive-concurrency';

/** Build a controller with deterministic RSS / memory-limit and a captured `apply`. */
function makeController(opts: {
  concurrency?: Parameters<typeof resolveConcurrency>[0];
  rss?: number;
  memLimit?: number;
}) {
  const applied: number[] = [];
  const controller = new AdaptiveController({
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    apply: (limit) => applied.push(limit),
    readRss: () => opts.rss ?? 100_000_000,
    readMemoryLimit: () => opts.memLimit ?? 8_000_000_000,
  });
  return { controller, applied };
}

/** Fill the completion window with `n` settled tasks each `durationMs`, `okRatio` fraction succeeding. */
function fill(c: AdaptiveController, n: number, durationMs: number, okRatio = 1): void {
  for (let i = 0; i < n; i++) {
    c.onStart();
    c.onSettle(durationMs, i / n < okRatio);
  }
}

describe('resolveConcurrency', () => {
  it('a bare number is fixed', () => {
    expect(resolveConcurrency(8)).toEqual({ mode: 'fixed', fixed: 8 });
  });

  it('undefined keeps the historical default of 1 (fixed)', () => {
    expect(resolveConcurrency(undefined)).toEqual({ mode: 'fixed', fixed: 1 });
  });

  it("'adaptive' applies every default", () => {
    expect(resolveConcurrency('adaptive')).toEqual({
      mode: 'adaptive',
      adaptive: { min: 1, max: 32, start: 1, ramCeilingPct: 85, tickMs: 2000 },
    });
  });

  it('an object overrides defaults and clamps start into [min,max]', () => {
    expect(
      resolveConcurrency({ mode: 'adaptive', min: 2, max: 6, start: 99, cpuCeilingPct: 90 }),
    ).toEqual({
      mode: 'adaptive',
      adaptive: { min: 2, max: 6, start: 6, ramCeilingPct: 85, tickMs: 2000, cpuCeilingPct: 90 },
    });
  });
});

describe('AdaptiveController.snapshot — the WorkerStatus contract', () => {
  it('fixed mode reports mode:fixed, limit, inFlight, rss* and (after work) throughput/p95', () => {
    const { controller } = makeController({
      concurrency: 4,
      rss: 200_000_000,
      memLimit: 1_000_000_000,
    });
    controller.onStart();
    controller.onStart();
    const before = controller.snapshot();
    expect(before.concurrency).toEqual({ mode: 'fixed', limit: 4 });
    expect(before.runtime).toBe('node');
    expect(before.inFlight).toBe(2);
    expect(before.rssBytes).toBe(200_000_000);
    expect(before.rssLimitBytes).toBe(1_000_000_000);
    expect(before.rssPct).toBeCloseTo(20);
    // no completions yet → these stay omitted
    expect(before.p95Ms).toBeUndefined();
    expect(before.throughputPerMin).toBeUndefined();

    controller.onSettle(100, true);
    controller.onSettle(100, true);
    const after = controller.snapshot();
    expect(after.inFlight).toBe(0);
    expect(after.p95Ms).toBe(100);
    expect(after.throughputPerMin).toBeGreaterThan(0);
  });

  it('adaptive mode carries min/max on the concurrency block', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 2, max: 16, start: 5 },
    });
    expect(controller.snapshot().concurrency).toEqual({
      mode: 'adaptive',
      limit: 5,
      min: 2,
      max: 16,
    });
  });
});

describe('AdaptiveController.tick — AIMD decisions', () => {
  it('grows by 1 when gradient is healthy AND saturated', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    fill(controller, 20, 100); // equal durations → rttLong≈p50 → gradient≈1
    for (let i = 0; i < 4; i++) controller.onStart(); // inFlight=4 ≥ 4*0.8 → saturated
    controller.tick();
    expect(controller.limit).toBe(5);
    expect(applied).toEqual([5]);
    expect(controller.snapshot().lastAdjust).toMatchObject({ from: 4, to: 5, reason: 'grow' });
  });

  it('does NOT grow when healthy but not saturated (raising a ceiling no one hits is meaningless)', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    fill(controller, 20, 100); // settled → inFlight back to 0, not saturated
    controller.tick();
    expect(controller.limit).toBe(4);
    expect(applied).toEqual([]);
  });

  it('shrinks by the gradient when latency inflates (queuing)', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 8 },
    });
    controller.onStart();
    controller.onSettle(10, true); // one fast sample seeds rttLong≈10
    fill(controller, 19, 100); // p50≈100 → gradient≈0.1 < 0.7 → shrink
    controller.tick();
    expect(controller.limit).toBeLessThan(8);
    expect(controller.snapshot().lastAdjust?.reason).toBe('shrink');
    expect(applied[0]).toBe(controller.limit);
  });

  it('hard-brakes on RAM when rssPct ≥ ramCeilingPct', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 5 },
      rss: 950_000_000,
      memLimit: 1_000_000_000, // 95% ≥ 85
    });
    fill(controller, 20, 100);
    controller.tick();
    expect(controller.limit).toBe(4); // floor(5*0.8)
    expect(controller.snapshot().lastAdjust?.reason).toBe('ram_ceiling');
  });

  it('sheds on backpressure when the error rate is high', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 5 },
    });
    fill(controller, 20, 100, 0.5); // 50% errors > 20%
    controller.tick();
    expect(controller.limit).toBe(4);
    expect(controller.snapshot().lastAdjust?.reason).toBe('backpressure');
  });

  it('never adjusts in fixed mode, but still tracks the window', () => {
    const { controller, applied } = makeController({ concurrency: 5 });
    fill(controller, 20, 100);
    for (let i = 0; i < 5; i++) controller.onStart();
    controller.tick();
    expect(controller.limit).toBe(5);
    expect(applied).toEqual([]);
    expect(controller.snapshot().lastAdjust).toBeUndefined();
  });
});
