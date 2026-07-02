import { z } from 'zod';
import { remoteStep } from './remote-step-factory';

describe('remoteStep', () => {
  it('builds a typed, branded remote step definition with no group key', () => {
    const step = remoteStep({
      name: 'a:b',
      input: z.object({ amount: z.number() }),
      output: z.object({ chargeId: z.string() }),
      retries: 3,
    });

    expect(step.__remote).toBe(true);
    expect(step.name).toBe('a:b');
    expect(step.partition).toBeUndefined();
    expect(step.retries).toBe(3);
    expect(step.input.parse({ amount: 10 })).toEqual({ amount: 10 });
    expect('group' in step).toBe(false);
  });

  it('carries an explicit partition', () => {
    const step = remoteStep({
      name: 'x',
      partition: 't',
      input: z.object({}),
      output: z.object({}),
    });

    expect(step.partition).toBe('t');
  });

  it('rejects a `group` key at the type level (alias removed)', () => {
    const step = remoteStep({
      name: 'x',
      // @ts-expect-error `group` was removed; use `partition` instead
      group: 'g',
      input: z.object({}),
      output: z.object({}),
    });

    expect(step.partition).toBeUndefined();
  });
});
