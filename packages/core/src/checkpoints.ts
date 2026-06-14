import type { StepCheckpoint, StepKind } from './interfaces';
import { stepId } from './protocol';

/**
 * Build an *instantaneous* checkpoint — one with no distinct enqueue/run/finish phases (a durable
 * sleep timer, a breakpoint marker, a delivered signal, a published `setEvent` value, a `patched`
 * marker). All three timestamps collapse to now and `attempts` is 1. Collapses what was five
 * near-identical 10-field `saveCheckpoint({...})` literals into one builder.
 */
export function instantCheckpoint(p: {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status?: StepCheckpoint['status'];
  output?: unknown;
  wakeAt?: number;
}): StepCheckpoint {
  const at = new Date();
  return {
    runId: p.runId,
    seq: p.seq,
    name: p.name,
    kind: p.kind,
    stepId: stepId(p.runId, p.seq),
    status: p.status ?? 'completed',
    output: p.output,
    wakeAt: p.wakeAt,
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
  };
}
