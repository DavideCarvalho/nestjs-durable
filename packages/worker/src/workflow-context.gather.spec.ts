import type { HistoryEvent } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { GatherReplayError, NondeterminismError, Suspend } from './errors';
import { WorkflowContext } from './workflow-context';

describe('WorkflowContext.gather', () => {
  it('runs every body and returns results in input order', async () => {
    const ctx = new WorkflowContext('r1', []);
    const out = await ctx.gather([
      ['a', () => 1],
      ['b', async () => 2],
      ['c', () => 3],
    ]);
    expect(out).toEqual([1, 2, 3]);
  });

  it('records N parallelGroup-tagged recordStep commands in seq order', async () => {
    const ctx = new WorkflowContext('r1', []);
    await ctx.gather([
      ['a', () => 1],
      ['b', () => 2],
    ]);
    expect(ctx.commands).toHaveLength(2);
    const group = 'gather:0';
    ctx.commands.forEach((cmd, i) => {
      expect(cmd.kind).toBe('recordStep');
      if (cmd.kind === 'recordStep') {
        expect(cmd.seq).toBe(i);
        expect(cmd.parallelGroup).toBe(group);
      }
    });
    const [a, b] = ctx.commands;
    if (a.kind === 'recordStep') expect(a.name).toBe('a');
    if (b.kind === 'recordStep') expect(b.name).toBe('b');
  });

  it('replays recorded outputs WITHOUT re-running the bodies', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 'a', output: 10 },
      { seq: 1, kind: 'step', name: 'b', output: 20 },
    ];
    const ctx = new WorkflowContext('r1', history);
    const out = await ctx.gather([
      [
        'a',
        () => {
          throw new Error('must not run on replay');
        },
      ],
      [
        'b',
        () => {
          throw new Error('must not run on replay');
        },
      ],
    ]);
    expect(out).toEqual([10, 20]);
    expect(ctx.commands).toHaveLength(0);
  });

  it('aggregates failures into a GatherReplayError (waitAll)', async () => {
    const ctx = new WorkflowContext('r1', []);
    const err = await ctx
      .gather([
        ['ok', () => 1],
        [
          'boom',
          () => {
            throw new Error('kaboom');
          },
        ],
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatherReplayError);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0].name).toBe('boom');
    expect(err.failures[0].index).toBe(1);
    // both steps were still recorded so the engine can persist partial progress
    expect(ctx.commands).toHaveLength(2);
  });

  it('replay re-raises GatherReplayError when a recorded item failed', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 'a', output: 1 },
      { seq: 1, kind: 'step', name: 'b', error: { message: 'boom' } },
    ];
    const ctx = new WorkflowContext('r1', history);
    const err = await ctx
      .gather([
        ['a', () => 1],
        ['b', () => 2],
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatherReplayError);
    expect(err.failures[0].name).toBe('b');
  });

  it('failFast throws a GatherReplayError when an item fails', async () => {
    const ctx = new WorkflowContext('r1', []);
    const err = await ctx
      .gather(
        [
          [
            'boom',
            () => {
              throw new Error('x');
            },
          ],
          ['ok', () => 1],
        ],
        { mode: 'failFast' },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatherReplayError);
  });

  it('empty items returns []', async () => {
    const ctx = new WorkflowContext('r1', []);
    expect(await ctx.gather([])).toEqual([]);
    expect(ctx.commands).toHaveLength(0);
  });

  it('a single item behaves like a single step', async () => {
    const ctx = new WorkflowContext('r1', []);
    const out = await ctx.gather([['only', () => 'v']]);
    expect(out).toEqual(['v']);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    if (cmd.kind === 'recordStep') {
      expect(cmd.name).toBe('only');
      expect(cmd.output).toBe('v');
      expect(cmd.parallelGroup).toBe('gather:0');
    }
  });

  it('captures body events on the recorded command', async () => {
    const ctx = new WorkflowContext('r1', []);
    await ctx.gather([
      [
        's',
        (log) => {
          log.info('hi');
        },
      ],
    ]);
    const cmd = ctx.commands[0];
    if (cmd.kind === 'recordStep') {
      expect(cmd.events?.[0].message).toBe('hi');
    }
  });

  it('raises NondeterminismError when a history slot kind/name mismatches', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 'a', output: 1 },
      { seq: 1, kind: 'timer' },
    ];
    const ctx = new WorkflowContext('r1', history);
    await expect(
      ctx.gather([
        ['a', () => 1],
        ['b', () => 2],
      ]),
    ).rejects.toBeInstanceOf(NondeterminismError);
  });
});

describe('WorkflowContext.all', () => {
  it('first turn emits all N startChild commands then suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.all('child', [{ x: 1 }, { x: 2 }])).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toHaveLength(2);
    const group = 'gather:0';
    ctx.commands.forEach((cmd, i) => {
      expect(cmd.kind).toBe('startChild');
      if (cmd.kind === 'startChild') {
        expect(cmd.seq).toBe(i);
        expect(cmd.workflow).toBe('child');
        expect(cmd.parallelGroup).toBe(group);
      }
    });
    if (ctx.commands[0].kind === 'startChild') expect(ctx.commands[0].input).toEqual({ x: 1 });
  });

  it('resume with some children done re-emits only the outstanding ones', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'child', name: 'child', output: 'a' }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.all('child', [{ x: 1 }, { x: 2 }])).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    if (cmd.kind === 'startChild') {
      expect(cmd.seq).toBe(1);
      expect(cmd.input).toEqual({ x: 2 });
    }
  });

  it('all resolved returns outputs in input order', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'child', name: 'child', output: 'a' },
      { seq: 1, kind: 'child', name: 'child', output: 'b' },
    ];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.all('child', [{ x: 1 }, { x: 2 }])).toEqual(['a', 'b']);
    expect(ctx.commands).toHaveLength(0);
  });

  it('waitAll aggregates child failures into GatherReplayError', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'child', name: 'child', output: 'a' },
      { seq: 1, kind: 'child', name: 'child', error: { message: 'boom' } },
    ];
    const ctx = new WorkflowContext('r1', history);
    const err = await ctx.all('child', [{ x: 1 }, { x: 2 }]).catch((e) => e);
    expect(err).toBeInstanceOf(GatherReplayError);
    expect(err.failures[0].workflow).toBe('child');
    expect(err.failures[0].index).toBe(1);
  });

  it('failFast raises on the first failed child seen', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'child', name: 'child', error: { message: 'boom' } },
    ];
    const ctx = new WorkflowContext('r1', history);
    const err = await ctx.all('child', [{ x: 1 }, { x: 2 }], { mode: 'failFast' }).catch((e) => e);
    expect(err).toBeInstanceOf(GatherReplayError);
  });

  it('empty inputs returns []', async () => {
    const ctx = new WorkflowContext('r1', []);
    expect(await ctx.all('child', [])).toEqual([]);
    expect(ctx.commands).toHaveLength(0);
  });

  it('raises NondeterminismError on a mismatched kind at a child seq', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', []);
    const c2 = new WorkflowContext('r1', history);
    void ctx;
    await expect(c2.all('child', [{ x: 1 }])).rejects.toBeInstanceOf(NondeterminismError);
  });
});
