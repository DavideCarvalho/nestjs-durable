import { describe, expect, it } from 'vitest';
import {
  type StepCheckpoint,
  type WorkflowRun,
  runDisplayStatus,
} from './durable-client';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'pipeline',
    workflowVersion: '1',
    status: 'suspended',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'processing',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('runDisplayStatus', () => {
  it('passes non-suspended statuses through unchanged', () => {
    expect(runDisplayStatus(run({ status: 'running' }))).toBe('running');
    expect(runDisplayStatus(run({ status: 'completed' }))).toBe('completed');
    expect(runDisplayStatus(run({ status: 'failed' }), [])).toBe('failed');
  });

  it('shows a suspended run with an in-flight remote step as running', () => {
    const timeline = [step({ status: 'completed' }), step({ seq: 1, status: 'pending' })];
    expect(runDisplayStatus(run(), timeline)).toBe('running');
  });

  it('shows a suspended run parked on a timer as sleeping', () => {
    expect(runDisplayStatus(run({ wakeAt: 9_999 }), [step()])).toBe('sleeping');
  });

  it('shows a suspended run with no pending step and no timer as awaiting (timeline known)', () => {
    expect(runDisplayStatus(run(), [step({ status: 'completed' })])).toBe('awaiting');
  });

  it('an in-flight step wins over a timer (more active state)', () => {
    expect(runDisplayStatus(run({ wakeAt: 9_999 }), [step({ status: 'pending' })])).toBe(
      'running',
    );
  });

  it('without a timeline (list view), a non-timer suspend reads as running, a timer as sleeping', () => {
    expect(runDisplayStatus(run())).toBe('running');
    expect(runDisplayStatus(run({ wakeAt: 9_999 }))).toBe('sleeping');
  });
});
