import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('WorkflowEngine — deterministic replay', () => {
  it('does not re-run an already-completed step when the run is resumed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const aRuns: number[] = [];
    let failOnce = true;

    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.step('a', async () => {
        aRuns.push(1);
        return 10;
      });
      const b = await ctx.step('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
      return b;
    });

    const first = await engine.start('wf', {}, 'run1');
    expect(first.status).toBe('failed');

    const second = await engine.resume('run1');
    expect(second.status).toBe('completed');
    expect(second.output).toBe(15);

    // 'a' completed on the first attempt, so resume must replay its checkpoint, not re-run it.
    expect(aRuns).toHaveLength(1);
  });

  it('retries a failing step up to the configured limit before the run succeeds', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let attempts = 0;
    engine.register('wf', '1', async (ctx) =>
      ctx.step(
        'flaky',
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('try again');
          return 'ok';
        },
        { retries: 3 },
      ),
    );

    const result = await engine.start('wf', {}, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('fails the run when a step exhausts its retries', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let attempts = 0;
    engine.register('wf', '1', async (ctx) =>
      ctx.step(
        'always-fails',
        async () => {
          attempts += 1;
          throw new Error('nope');
        },
        { retries: 2 },
      ),
    );

    const result = await engine.start('wf', {}, 'run1');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('nope');
    expect(attempts).toBe(2);
  });
});
