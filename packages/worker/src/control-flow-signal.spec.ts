import { isWorkflowControlFlowSignal } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { Cancelled, StepFailed, Suspend } from './errors';

/**
 * Cross-runtime check: the thin worker's `Suspend` must be recognized by durable-core's
 * `isWorkflowControlFlowSignal` even though it is a DIFFERENT class than core's
 * `WorkflowSuspended`/`ContinueAsNew` — this is the exact cross-package case that regressed in a
 * consumer (nestjs-agent) misclassifying a thin-worker `Suspend` as a real failure. `Cancelled` and
 * `StepFailed` must stay rejected — see the exclusions documented on the predicate.
 */
describe('isWorkflowControlFlowSignal (thin worker)', () => {
  it('recognizes the worker Suspend signal', () => {
    expect(isWorkflowControlFlowSignal(new Suspend())).toBe(true);
  });

  it('rejects Cancelled — a terminal outcome, not control-flow', () => {
    expect(isWorkflowControlFlowSignal(new Cancelled('run-1'))).toBe(false);
  });

  it('rejects StepFailed — a real failure a workflow catch should handle', () => {
    expect(isWorkflowControlFlowSignal(new StepFailed({ message: 'boom' }))).toBe(false);
  });

  it('survives subclassing', () => {
    class CustomSuspend extends Suspend {}
    expect(isWorkflowControlFlowSignal(new CustomSuspend())).toBe(true);
  });
});
