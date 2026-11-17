import { MAX_FAMILY_LENGTH, runEventFamily, stepEventFamily } from './durable-run-family';

describe('stepEventFamily', () => {
  it("names a step's outcome, completed or failed alike", () => {
    expect(stepEventFamily('step.completed', 'charge', 'local')).toBe('durable:step:charge');
    expect(stepEventFamily('step.failed', 'charge', 'remote')).toBe('durable:step:charge');
  });

  it('gives no family to other events, unnamed steps, or sleep / signal waits', () => {
    expect(stepEventFamily('step.started', 'charge', 'local')).toBeUndefined();
    expect(stepEventFamily('run.completed', 'charge')).toBeUndefined();
    expect(stepEventFamily('step.completed', undefined)).toBeUndefined();
    expect(stepEventFamily('step.completed', '')).toBeUndefined();
    expect(stepEventFamily('step.completed', 'nap', 'sleep')).toBeUndefined();
    expect(stepEventFamily('step.completed', 'approval', 'signal')).toBeUndefined();
  });

  it('keeps a long name within the narrowest family column, two long names apart', () => {
    const a = stepEventFamily('step.completed', `${'x'.repeat(80)}-a`);
    const b = stepEventFamily('step.completed', `${'x'.repeat(80)}-b`);
    expect(a).toHaveLength(MAX_FAMILY_LENGTH);
    expect(b).toHaveLength(MAX_FAMILY_LENGTH);
    expect(a).not.toBe(b);
    expect(a?.startsWith('durable:step:xxx')).toBe(true);
    // The same name always maps to the same family.
    expect(stepEventFamily('step.failed', `${'x'.repeat(80)}-a`)).toBe(a);
  });

  it('leaves run families as they were', () => {
    expect(runEventFamily('run.completed')).toBe('durable:run.completed');
    expect(runEventFamily('step.completed')).toBeUndefined();
  });
});
