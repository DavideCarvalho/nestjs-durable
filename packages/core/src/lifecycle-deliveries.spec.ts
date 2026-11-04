import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './interfaces';
import { lifecycleDeliveriesOf, traceIdOfTraceparent } from './lifecycle-deliveries';
import {
  LIFECYCLE_COALESCED_TAG_PREFIX,
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX,
} from './lifecycle-events';

const run = (status: WorkflowRun['status'], tags: string[]) => ({
  id: 'i1',
  status,
  tags,
  updatedAt: new Date(1_000),
});

describe('lifecycleDeliveriesOf', () => {
  it('states started, owed (with an orphan deadline when nobody live has it), coalesced and not started', () => {
    const settled = run('completed', [
      LIFECYCLE_PENDING_TAG,
      `${LIFECYCLE_OWED_TAG_PREFIX}gone`,
      `${LIFECYCLE_OWED_TAG_PREFIX}later`,
      'durable:triggered:refresh',
    ]);
    expect(
      lifecycleDeliveriesOf(settled, {
        subscribers: ['digest', 'later', 'quiet', 'refresh'],
        live: new Set(['digest', 'later', 'quiet', 'refresh']),
        coalesced: new Map([['digest', '__evtacc__:digest']]),
      }),
    ).toEqual([
      { subscriber: 'digest', state: 'coalesced', runId: '__evtacc__:digest' },
      {
        subscriber: 'gone',
        state: 'owed',
        owedSince: 1_000,
        orphanAt: 1_000 + LIFECYCLE_ORPHAN_MS,
      },
      { subscriber: 'later', state: 'owed', owedSince: 1_000 },
      { subscriber: 'quiet', state: 'not-started' },
      { subscriber: 'refresh', state: 'started', runId: 'evt:i1:completed:refresh' },
    ]);
  });

  it('reads a run marked with the pending tag alone as owed to every subscriber', () => {
    expect(
      lifecycleDeliveriesOf(run('failed', [LIFECYCLE_PENDING_TAG]), {
        subscribers: ['a'],
        live: new Set(['a']),
      }),
    ).toEqual([{ subscriber: 'a', state: 'owed', owedSince: 1_000 }]);
  });

  it('states failed for a subscriber tagged trigger_failed, unless it has since started', () => {
    const settled = run('completed', [
      `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}broken`,
      `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}removed`,
      `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}retried`,
      'durable:triggered:retried',
    ]);
    expect(
      lifecycleDeliveriesOf(settled, {
        subscribers: ['broken', 'retried'],
        live: new Set(['broken', 'retried']),
      }),
    ).toEqual([
      { subscriber: 'broken', state: 'failed' },
      { subscriber: 'removed', state: 'failed' },
      { subscriber: 'retried', state: 'started', runId: 'evt:i1:completed:retried' },
    ]);
  });

  it('states coalesced for a subscriber tagged coalesced, keeping the accumulator link', () => {
    const settled = run('completed', [
      `${LIFECYCLE_COALESCED_TAG_PREFIX}digest`,
      `${LIFECYCLE_COALESCED_TAG_PREFIX}removed`,
    ]);
    expect(
      lifecycleDeliveriesOf(settled, {
        subscribers: ['digest'],
        live: new Set(['digest']),
        coalesced: new Map([['digest', '__evtacc__:digest']]),
      }),
    ).toEqual([
      { subscriber: 'digest', state: 'coalesced', runId: '__evtacc__:digest' },
      { subscriber: 'removed', state: 'coalesced' },
    ]);
  });

  it('leaves the accumulator out when it cannot be derived, and is empty before settling', () => {
    expect(
      lifecycleDeliveriesOf(run('completed', []), {
        subscribers: ['digest'],
        live: new Set(['digest']),
        coalesced: new Map([['digest', undefined]]),
      }),
    ).toEqual([{ subscriber: 'digest', state: 'coalesced' }]);
    expect(
      lifecycleDeliveriesOf(run('running', []), { subscribers: ['a'], live: new Set(['a']) }),
    ).toEqual([]);
  });
});

describe('traceIdOfTraceparent', () => {
  it('reads the trace id of a valid traceparent only', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(traceIdOfTraceparent(`00-${id}-00f067aa0ba902b7-01`)).toBe(id);
    expect(traceIdOfTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(traceIdOfTraceparent('garbage')).toBeUndefined();
    expect(traceIdOfTraceparent(undefined)).toBeUndefined();
  });
});
