/**
 * Compile-time guard for `@OnWorkflowCompleted` / `@OnWorkflowFailed`: with a class ref, the
 * decorated workflow's `run` input must accept the lifecycle event, or what `input` builds from it;
 * `where` and `input` see the source workflow's typed input and output. A string ref is not
 * checked. No runtime assertions: checked by `pnpm typecheck` only (tsc includes src/**, excludes
 * *.spec.ts).
 */
import type { LifecycleEventOf, WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { OnWorkflowCompleted, OnWorkflowFailed, Workflow } from './decorators';

@Workflow({ name: 'type-test-ingest' })
class IngestWorkflow {
  async run(_ctx: WorkflowCtx, input: { baseId: string; type: string }): Promise<{ rows: number }> {
    return { rows: input.baseId.length };
  }
}

// Positive: the subscriber takes the typed event, and `where` reads the source's input and output.
@Workflow({ name: 'type-test-takes-event' })
@OnWorkflowCompleted(IngestWorkflow, {
  where: (e) => e.input.type === 'mvr' && (e.output?.rows ?? 0) > 0,
})
class TakesEvent {
  async run(_ctx: WorkflowCtx, event: LifecycleEventOf<typeof IngestWorkflow>) {
    return event.input.baseId;
  }
}

// Positive: `input` maps the event to the subscriber's own input shape.
@Workflow({ name: 'type-test-takes-mapped' })
@OnWorkflowCompleted(IngestWorkflow, { input: (e) => ({ baseId: e.input.baseId }) })
class TakesMapped {
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: without `input`, a subscriber expecting another shape does not compile.
@Workflow({ name: 'type-test-wrong-shape' })
// @ts-expect-error run's input is not the lifecycle event
@OnWorkflowCompleted(IngestWorkflow)
class WrongShape {
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: `input`'s result must match the subscriber's input.
@Workflow({ name: 'type-test-wrong-mapped' })
// @ts-expect-error run expects a number where `input` builds a string
@OnWorkflowFailed(IngestWorkflow, {
  statuses: ['failed', 'dead'],
  input: (e) => ({ baseId: e.input.baseId }),
})
class WrongMapped {
  async run(_ctx: WorkflowCtx, input: { baseId: number }) {
    return input.baseId;
  }
}

// A string ref carries no types, so it does not constrain the subscriber.
@Workflow({ name: 'type-test-by-name' })
@OnWorkflowFailed('type-test-ingest')
class ByName {
  async run(_ctx: WorkflowCtx, input: { anything: true }) {
    return input;
  }
}

// Positive: `key` receives what `input` builds.
@Workflow({ name: 'type-test-debounced' })
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  debounce: { windowMs: '30s', key: (input) => input.baseId },
})
class Debounced {
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Positive: without `input`, `key` receives the lifecycle event.
@Workflow({ name: 'type-test-debounced-event' })
@OnWorkflowCompleted(IngestWorkflow, {
  debounce: { windowMs: 1000, key: (e) => e.input.baseId },
})
class DebouncedEvent {
  async run(_ctx: WorkflowCtx, event: LifecycleEventOf<typeof IngestWorkflow>) {
    return event.runId;
  }
}

// Negative: `key` cannot read a field the subscriber's input does not have.
@Workflow({ name: 'type-test-wrong-key' })
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  // @ts-expect-error `type` is not on the mapped input
  debounce: { windowMs: '30s', key: (input) => input.type },
})
class WrongKey {
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Positive: a batched subscriber takes `{ events }` of its input.
@Workflow({ name: 'type-test-batched' })
@OnWorkflowFailed(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  batch: { maxSize: 10, windowMs: '1m', key: (input) => input.baseId },
})
class Batched {
  async run(_ctx: WorkflowCtx, input: { events: { baseId: string }[] }) {
    return input.events.length;
  }
}

// Negative: a batched subscriber that takes one input does not compile.
@Workflow({ name: 'type-test-batched-single' })
// @ts-expect-error a batched run receives { events }, not one input
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  batch: { maxSize: 10, windowMs: '1m' },
})
class BatchedSingle {
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: debounce and batch together.
@Workflow({ name: 'type-test-both' })
// @ts-expect-error a subscription takes debounce or batch, not both
@OnWorkflowCompleted(IngestWorkflow, {
  debounce: { windowMs: 1000 },
  batch: { maxSize: 10, windowMs: 1000 },
})
class Both {
  async run(_ctx: WorkflowCtx, input: { events: LifecycleEventOf<typeof IngestWorkflow>[] }) {
    return input;
  }
}

// `ctx.waitForRun`: by id the output is what the caller says; with the class it is the workflow's.
@Workflow({ name: 'type-test-wait-for-run' })
class WaitsForRun {
  async run(ctx: WorkflowCtx, input: { ingestRunId: string }) {
    const byId = await ctx.waitForRun<{ rows: number }>(input.ingestRunId, { timeoutMs: '1h' });
    const rows: number | undefined = byId.output?.rows;
    const typed = await ctx.waitForRun(IngestWorkflow, input.ingestRunId);
    const baseId: string = typed.input.baseId;
    const typedRows: number | undefined = typed.output?.rows;
    // @ts-expect-error the ingest output has no `count`
    typed.output?.count;
    return { rows, baseId, typedRows, status: typed.status };
  }
}

void [
  TakesEvent,
  TakesMapped,
  WrongShape,
  WrongMapped,
  ByName,
  Debounced,
  DebouncedEvent,
  WrongKey,
  Batched,
  BatchedSingle,
  Both,
  WaitsForRun,
];
