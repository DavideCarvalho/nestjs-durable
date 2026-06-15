import { describe, expect, it } from 'vitest';
import type { StepEvent } from './interfaces';
import { createStepLogger } from './step-logger';

const at = () => 1000;

describe('createStepLogger', () => {
  it('sub() keeps its existing shape (no subId — back-compat)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).sub('ProcessKpi', 'ok');
    expect(events).toEqual([
      { at: 1000, level: 'info', message: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' },
    ]);
  });

  it('subEvent() records an intermediate phase (no status)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      group: 'af_fleet',
      phase: 'processing',
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'info',
        message: 'processing',
        subId: 'r1',
        name: 'ProcessKpi',
        group: 'af_fleet',
        phase: 'processing',
      },
    ]);
  });

  it('subEvent() records a terminal outcome, mapping failed → error level and keeping data', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      status: 'failed',
      data: { durationMs: 42 },
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'error',
        message: 'ProcessKpi',
        subId: 'r1',
        name: 'ProcessKpi',
        status: 'failed',
        data: { durationMs: 42 },
      },
    ]);
  });

  it('subEvent() maps skipped → warn level', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({ id: 'r1', name: 'ProcessKpi', status: 'skipped' });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'warn',
        message: 'ProcessKpi',
        subId: 'r1',
        name: 'ProcessKpi',
        status: 'skipped',
      },
    ]);
  });
});
