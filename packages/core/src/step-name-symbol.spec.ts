import { describe, expect, it } from 'vitest';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  stepConfigOf,
  stepNameOf,
} from './step-name-symbol';

describe('step name stamp', () => {
  it('reads a stamped name off a function ref', () => {
    function handler() {}
    (handler as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = 'Svc.handler';
    expect(stepNameOf(handler)).toBe('Svc.handler');
  });
  it('returns undefined for an unstamped value or a plain string', () => {
    expect(stepNameOf(() => {})).toBeUndefined();
    expect(stepNameOf('Svc.handler')).toBeUndefined();
  });
  it('uses the global registry symbol (survives duplicate module copies)', () => {
    expect(DURABLE_STEP_NAME).toBe(Symbol.for('durable.step.name'));
  });
});

describe('step config stamp', () => {
  it('reads a stamped dispatch policy off a function ref', () => {
    function handler() {}
    const config: StepConfig = { retries: 3, backoff: 'exp', backoffMs: 100, timeoutMs: 5000 };
    (handler as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
    expect(stepConfigOf(handler)).toEqual(config);
  });
  it('returns undefined for an unstamped value or a plain string', () => {
    expect(stepConfigOf(() => {})).toBeUndefined();
    expect(stepConfigOf('Svc.handler')).toBeUndefined();
  });
  it('uses the global registry symbol (survives duplicate module copies)', () => {
    expect(DURABLE_STEP_CONFIG).toBe(Symbol.for('durable.step.config'));
  });
});
