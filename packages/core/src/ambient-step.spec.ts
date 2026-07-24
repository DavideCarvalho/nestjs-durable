import { describe, expect, it } from 'vitest';
import {
  currentStep,
  debug,
  error,
  info,
  log,
  runInStepLogger,
  sub,
  subEvent,
  subProcess,
  warn,
} from './ambient-step';
import type { StepEvent, StepLogger } from './interfaces';
import { createStepLogger } from './step-logger';

const at = () => 1000;

/** A logger over a fresh event array, as the engine builds one per step attempt. */
const makeLogger = () => {
  const events: StepEvent[] = [];
  return { events, logger: createStepLogger(events, at) };
};

describe('ambient step logger', () => {
  it('currentStep() is undefined outside a step', () => {
    expect(currentStep()).toBeUndefined();
  });

  it('currentStep() sees the same logger through nested awaits', async () => {
    const { logger } = makeLogger();
    // Several layers deep, each crossing an await — the case that motivates the ALS: a utility
    // buried under the handler that never received the logger as a parameter.
    const level3 = async () => {
      await Promise.resolve();
      return currentStep();
    };
    const level2 = async () => {
      await Promise.resolve();
      return level3();
    };
    const level1 = async () => {
      await Promise.resolve();
      return level2();
    };
    const seen = await runInStepLogger(logger, level1);
    expect(seen).toBe(logger);
  });

  it('currentStep() is undefined again after the step body settles', async () => {
    const { logger } = makeLogger();
    await runInStepLogger(logger, async () => {
      expect(currentStep()).toBe(logger);
    });
    expect(currentStep()).toBeUndefined();
  });

  it('concurrent step invocations never leak their logger into one another', async () => {
    // THE test that matters: the worker runs steps under adaptive concurrency, so two step bodies
    // interleave on the same event loop. Each must only ever see (and emit into) its own logger.
    const a = makeLogger();
    const b = makeLogger();

    const body = (name: string, delays: number[]) =>
      runInStepLogger(name === 'a' ? a.logger : b.logger, async () => {
        const seen: (StepLogger | undefined)[] = [];
        for (const delay of delays) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          seen.push(currentStep());
          log('info', `${name} tick`);
        }
        return seen;
      });

    // Deliberately interleaved delays, so the two bodies resume inside each other's gaps.
    const [seenA, seenB] = await Promise.all([body('a', [0, 4, 1]), body('b', [2, 0, 3])]);

    expect(seenA.every((s) => s === a.logger)).toBe(true);
    expect(seenB.every((s) => s === b.logger)).toBe(true);
    expect(a.events.map((e) => e.message)).toEqual(['a tick', 'a tick', 'a tick']);
    expect(b.events.map((e) => e.message)).toEqual(['b tick', 'b tick', 'b tick']);
  });

  it('a nested step body rebinds, and the outer binding is restored on exit', async () => {
    const outer = makeLogger();
    const inner = makeLogger();
    await runInStepLogger(outer.logger, async () => {
      await runInStepLogger(inner.logger, async () => {
        expect(currentStep()).toBe(inner.logger);
      });
      expect(currentStep()).toBe(outer.logger);
    });
  });

  describe('module shortcuts', () => {
    it('emit onto the ambient logger inside a step', async () => {
      const { events, logger } = makeLogger();
      await runInStepLogger(logger, async () => {
        log('warn', 'careful', { n: 1 });
        sub('ProcessKpi', 'ok');
        subEvent({ id: 'r1', name: 'ProcessKpi', phase: 'processing' });
        const out = await subProcess('export-file', async () => 'done', { id: 's1' });
        expect(out).toBe('done');
      });
      expect(events).toMatchObject([
        { level: 'warn', message: 'careful', data: { n: 1 } },
        { level: 'info', message: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' },
        { level: 'info', message: 'processing', subId: 'r1', phase: 'processing' },
        { level: 'info', subId: 's1', name: 'export-file', status: 'ok' },
      ]);
    });

    it('are no-ops outside a step and do not throw', async () => {
      expect(() => log('info', 'nobody listening')).not.toThrow();
      expect(() => sub('ProcessKpi', 'ok')).not.toThrow();
      expect(() => subEvent({ id: 'r1', name: 'ProcessKpi', status: 'ok' })).not.toThrow();
    });

    it('the per-level shortcuts each emit at their own level inside a step', async () => {
      const { events, logger } = makeLogger();
      await runInStepLogger(logger, async () => {
        debug('d', { n: 1 });
        info('i');
        warn('w');
        error('e');
      });
      expect(events).toEqual([
        { at: 1000, level: 'debug', message: 'd', data: { n: 1 } },
        { at: 1000, level: 'info', message: 'i' },
        { at: 1000, level: 'warn', message: 'w' },
        { at: 1000, level: 'error', message: 'e' },
      ]);
    });

    it('the per-level shortcuts agree with log(level, …)', async () => {
      // The two forms are alternative spellings of one emission, not two behaviours.
      const viaShortcut = makeLogger();
      const viaLog = makeLogger();
      await runInStepLogger(viaShortcut.logger, async () => warn('careful', { n: 1 }));
      await runInStepLogger(viaLog.logger, async () => log('warn', 'careful', { n: 1 }));
      expect(viaShortcut.events).toEqual(viaLog.events);
    });

    it('the per-level shortcuts are no-ops outside a step and do not throw', () => {
      expect(() => debug('nobody listening')).not.toThrow();
      expect(() => info('nobody listening')).not.toThrow();
      expect(() => warn('nobody listening')).not.toThrow();
      // `error` only RECORDS a line — outside a step it must stay silent, not throw.
      expect(() => error('nobody listening')).not.toThrow();
    });

    it('subProcess() still runs the body outside a step (only the emission disappears)', async () => {
      let ran = false;
      const out = await subProcess('export-file', async (sp) => {
        // The handle is still handed over, so the same business code takes the same path.
        sp.phase('working');
        ran = true;
        return 42;
      });
      expect(ran).toBe(true);
      expect(out).toBe(42);
    });

    it('subProcess() outside a step still propagates the body error', async () => {
      await expect(
        subProcess('export-file', async () => {
          throw new Error('s3 down');
        }),
      ).rejects.toThrow('s3 down');
    });
  });

  it('events emitted from a nested helper land in the step’s StepEvent[]', async () => {
    // End-to-end: the helper takes no logger parameter at all — exactly the shape of a generic
    // utility (a batch inserter) that the caller cannot be asked to thread a handle through.
    const { events, logger } = makeLogger();
    const insertRows = async (rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        await Promise.resolve();
      }
      currentStep()?.subEvent({ id: 'batch', name: 'insert', phase: `${rows} rows` });
      log('debug', 'flushed');
    };
    const handler = async () => {
      await subProcess('write', async () => insertRows(3), { id: 'sp1' });
    };

    await runInStepLogger(logger, handler);

    expect(events.map((e) => e.phase ?? e.message)).toEqual(['3 rows', 'flushed', 'write']);
    expect(events[0]).toMatchObject({ subId: 'batch', name: 'insert' });
    // The plain log line was emitted inside the sub-process body → tagged to it, so the dashboard
    // groups the trail under the sub-process.
    expect(events[1].subId).toBe('sp1');
    expect(events[2]).toMatchObject({ subId: 'sp1', name: 'write', status: 'ok' });
  });
});
