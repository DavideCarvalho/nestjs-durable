import { describe, expect, it } from 'vitest';
import { eventToken } from './events';
import type { SignalWaiter, WorkflowRun } from './interfaces';
import { breakpointToken } from './protocol';
import { classifyWaiterToken, indexWaitersByRun, resolveRunWaiting } from './run-waiting';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'pipeline',
    workflowVersion: '1',
    status: 'suspended',
    input: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function waiter(over: Partial<SignalWaiter> & { token: string }): SignalWaiter {
  return { runId: 'r1', seq: 0, ...over };
}

describe('classifyWaiterToken', () => {
  it('classifies a webhook token (wh:<runId>:<seq>)', () => {
    expect(classifyWaiterToken('wh:r1:0')).toEqual({ on: 'webhook', name: 'wh:r1:0' });
  });

  it('classifies a child-await token (child:<id>), stripping the prefix for the name', () => {
    expect(classifyWaiterToken('child:kid-7')).toEqual({ on: 'child', name: 'kid-7' });
  });

  it('classifies a named-event token, decoding the event name', () => {
    const token = eventToken('order.paid', { region: 'us' }, 'r1', 3);
    expect(classifyWaiterToken(token)).toEqual({ on: 'signal', name: 'order.paid' });
  });

  it('treats a plain signal token as the signal name', () => {
    expect(classifyWaiterToken('approve')).toEqual({ on: 'signal', name: 'approve' });
  });

  it('classifies a breakpoint token (bp:<runId>:<seq>) as `breakpoint`, not a raw-token signal', () => {
    expect(classifyWaiterToken('bp:r1:3')).toEqual({ on: 'breakpoint', name: 'breakpoint' });
  });
});

describe('indexWaitersByRun', () => {
  it('indexes by runId, keeping the first waiter seen per run', () => {
    const idx = indexWaitersByRun([
      waiter({ token: 'approve', runId: 'r1', seq: 0 }),
      waiter({ token: 'other', runId: 'r1', seq: 1 }),
      waiter({ token: 'go', runId: 'r2', seq: 0 }),
    ]);
    expect(idx.get('r1')?.token).toBe('approve');
    expect(idx.get('r2')?.token).toBe('go');
  });
});

describe('resolveRunWaiting', () => {
  it('resolves the event a suspended run is parked on from its waiter', () => {
    const idx = indexWaitersByRun([waiter({ token: 'wh:r1:0', runId: 'r1' })]);
    expect(resolveRunWaiting(run({ id: 'r1' }), idx)).toEqual({ on: 'webhook', name: 'wh:r1:0' });
  });

  it('is undefined for a suspended run with no waiter (a sleep / in-flight step / orphan)', () => {
    expect(resolveRunWaiting(run({ id: 'r1', wakeAt: 9_999 }), new Map())).toBeUndefined();
  });

  it('is undefined for a non-suspended run even if a stale waiter lingers', () => {
    const idx = indexWaitersByRun([waiter({ token: 'approve', runId: 'r1' })]);
    expect(resolveRunWaiting(run({ id: 'r1', status: 'running' }), idx)).toBeUndefined();
  });

  it('resolves a real `ctx.breakpoint` waiter (bp:<runId>:<seq>) as `breakpoint`', () => {
    const idx = indexWaitersByRun([
      waiter({ token: breakpointToken('r1', 4), runId: 'r1', seq: 4 }),
    ]);
    expect(resolveRunWaiting(run({ id: 'r1' }), idx)).toEqual({
      on: 'breakpoint',
      name: 'breakpoint',
    });
  });
});
