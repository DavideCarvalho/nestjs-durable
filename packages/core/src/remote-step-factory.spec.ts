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

  it('deprecated: maps a legacy `group` to `partition` and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const step = remoteStep({
      name: 'x',
      group: 'g',
      input: z.object({}),
      output: z.object({}),
    });

    expect(step.partition).toBe('g');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
