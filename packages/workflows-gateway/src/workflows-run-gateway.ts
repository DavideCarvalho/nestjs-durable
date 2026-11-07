import {
  type DurableTopology,
  type EngineEvent,
  type GroupHealth,
  type RunDetail,
  type RunFacetQuery,
  type RunFacetRow,
  RunGateway,
  type RunListItem,
  type RunQuery,
  type RunResult,
  type RunStatus,
  type RunValueFacetRow,
  type RunWaiting,
  type StepCheckpoint,
  type StepError,
  type StepKind,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import {
  type SerializedWorkflowError,
  WorkflowClient,
  type WorkflowEvent,
  WorkflowEvents,
  type WorkflowInstance,
  type WorkflowInstanceDetails,
  type WorkflowJournalEntry,
  WorkflowNotFoundError,
  type WorkflowStatus,
  type WorkflowWait,
} from '@nestjs/workflows';

/** The most instances one list/facet read pulls from the official store (it has no counts or sort). */
export const WORKFLOWS_LIST_CAP = 1000;

/** Official statuses → the console's run statuses. */
const TO_RUN_STATUS: Record<WorkflowStatus, RunStatus> = {
  pending: 'pending',
  running: 'running',
  suspended: 'suspended',
  // Undoing after a failure or a cancel: in progress, on its way to a terminal status.
  compensating: 'cancelling',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  // An undo that gave up: needs a person, and `retry` is the way out, like a dead run.
  compensation_failed: 'dead',
};

const ALL_OFFICIAL: WorkflowStatus[] = Object.keys(TO_RUN_STATUS) as WorkflowStatus[];

/** Console statuses → the official ones they stand for (`blocked` has none). */
function toOfficialStatuses(statuses: readonly RunStatus[]): WorkflowStatus[] {
  return ALL_OFFICIAL.filter((s) => statuses.includes(TO_RUN_STATUS[s]));
}

/** What the official engine and its store cannot answer: the console hides these controls. */
const CAPABILITIES: NonNullable<DurableTopology['capabilities']> = {
  searchAttributes: false,
  namespaces: false,
  tags: false,
  origins: false,
  breakpoints: false,
  redispatch: false,
  republishLifecycle: false,
  schedules: false,
  workers: false,
};

/** Journal kinds the timeline leaves out: replay helpers (`ctx.now()`/`random()`/`uuid()`), not work. */
const HELPER_KINDS = new Set<WorkflowJournalEntry['kind']>(['now', 'random', 'uuid']);

function toStepError(error: SerializedWorkflowError | null | undefined): StepError | undefined {
  if (!error) return undefined;
  const e = error as SerializedWorkflowError & { name?: string; stack?: string; code?: string };
  return {
    message: e.message ?? String(e.name ?? 'error'),
    ...(e.name ? { code: e.name } : {}),
    ...(e.stack ? { stack: e.stack } : {}),
    ...(error.compensation ? { details: { compensation: error.compensation } } : {}),
  };
}

/** An official instance as a durable run row. */
export function toWorkflowRun(instance: WorkflowInstance): WorkflowRun {
  const error = toStepError(instance.error);
  return {
    id: instance.id,
    workflow: instance.workflow,
    workflowVersion: String(instance.version),
    status: TO_RUN_STATUS[instance.status],
    input: instance.input,
    ...(instance.output !== undefined ? { output: instance.output } : {}),
    ...(error ? { error } : {}),
    ...(instance.wakeAt !== null ? { wakeAt: instance.wakeAt } : {}),
    ...(instance.leaseOwner ? { lockedBy: instance.leaseOwner } : {}),
    ...(instance.leaseUntil !== null ? { lockedUntil: instance.leaseUntil } : {}),
    ...(instance.priority ? { priority: instance.priority } : {}),
    createdAt: new Date(instance.createdAt),
    updatedAt: new Date(instance.updatedAt),
  };
}

function stepKind(kind: WorkflowJournalEntry['kind']): StepKind {
  if (kind === 'sleep') return 'sleep';
  if (kind === 'signal' || kind === 'any' || kind === 'child') return 'signal';
  return 'local';
}

/** The journal as the console's step timeline. */
export function toTimeline(instance: WorkflowInstanceDetails): StepCheckpoint[] {
  const timeline: StepCheckpoint[] = [];
  (instance.journal ?? []).forEach((entry, seq) => {
    if (HELPER_KINDS.has(entry.kind)) return;
    const at = new Date(entry.updatedAt ?? instance.updatedAt);
    const cancelled = entry.status === 'cancelled';
    const error =
      toStepError(entry.error) ??
      (cancelled ? { message: `${entry.kind} cancelled when the instance ended` } : undefined);
    timeline.push({
      runId: instance.id,
      seq,
      name: entry.kind === 'step' ? entry.name : `${entry.kind}:${entry.name}`,
      kind: stepKind(entry.kind),
      stepId: `${instance.id}:${entry.name}`,
      status: entry.status === 'cancelled' ? 'failed' : entry.status,
      ...(entry.data !== undefined ? { input: entry.data } : {}),
      ...(entry.result !== undefined ? { output: entry.result } : {}),
      ...(error ? { error } : {}),
      attempts: entry.attempts,
      ...(entry.wakeAt != null ? { wakeAt: entry.wakeAt } : {}),
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
  });
  return timeline;
}

function waitingOf(waits: WorkflowWait[] | undefined): RunWaiting | undefined {
  const wait = waits?.[0];
  if (!wait) return undefined;
  return { on: 'signal', name: wait.key ? `${wait.signal} (key ${wait.key})` : wait.signal };
}

/** Official lifecycle events → the engine events the console's live stream understands. */
export function toEngineEvent(event: WorkflowEvent): EngineEvent | undefined {
  const base = { runId: event.id, workflow: event.workflow, at: new Date(event.at) };
  switch (event.type) {
    case 'workflow-started':
    case 'workflow-resumed':
    case 'workflow-retried':
      return { ...base, type: 'run.started' };
    case 'workflow-suspended':
      return { ...base, type: 'run.suspended' };
    case 'workflow-completed':
      return { ...base, type: 'run.completed', output: event.output };
    case 'workflow-failed':
    case 'workflow-cancelled':
    case 'workflow-compensation-failed':
      return { ...base, type: 'run.failed', error: toStepError(event.error) };
    case 'step-completed':
      return {
        ...base,
        type: 'step.completed',
        name: event.step,
        kind: 'local',
        durationMs: event.durationMs,
      };
    case 'step-failed':
      return {
        ...base,
        type: 'step.failed',
        name: event.step,
        kind: 'local',
        error: toStepError(event.error),
      };
    default:
      return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof WorkflowNotFoundError ||
    (error as { name?: string })?.name === 'WorkflowNotFoundError'
  );
}

/**
 * Durable's dashboard seam ({@link RunGateway}) implemented on the official `@nestjs/workflows`
 * engine: its `WorkflowClient` for reads and control, its `WorkflowEvents` for live updates.
 *
 * Mapping: `compensating` shows as `cancelling`, `compensation_failed` as `dead` (needs a person;
 * `retry` reopens it). `Cancel + Undo` is `client.cancel()` (compensations run), plain `Cancel` is
 * `client.terminate()` (they don't). `Fix & replay` starts a fresh instance of the same workflow and
 * version with the corrected input. What the official store has no notion of (search attributes,
 * tags, namespaces, origins, breakpoints, lost-dispatch recovery, lifecycle events, worker health)
 * is declared unsupported in {@link topology}, and the console hides it.
 */
@Injectable()
export class WorkflowsRunGateway extends RunGateway {
  constructor(
    private readonly client: WorkflowClient,
    private readonly events: WorkflowEvents,
  ) {
    super();
  }

  topology(): DurableTopology {
    return { role: 'control-plane', engine: '@nestjs/workflows', capabilities: CAPABILITIES };
  }

  override async getRun(runId: string): Promise<WorkflowRun | null> {
    const instance = await this.client.getStatus(runId);
    return instance ? toWorkflowRun(instance) : null;
  }

  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const instance = await this.client.getStatus(runId, { journal: true, children: true });
    if (!instance) return null;
    return {
      run: toWorkflowRun(instance),
      timeline: toTimeline(instance),
      children: (instance.children ?? []).map((child) => child.id),
    };
  }

  /**
   * Newest first, like the durable console. The official `list()` pages oldest first with no total,
   * so this reads up to {@link WORKFLOWS_LIST_CAP} matching instances and pages them here.
   */
  async listRuns(query: RunQuery): Promise<RunListItem[]> {
    const instances = await this.matching(query);
    instances.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const offset = query.offset ?? 0;
    const page = instances.slice(offset, offset + (query.limit ?? 100)).map(toWorkflowRun);
    const waiting = await this.waitingFor(
      page.filter((r) => r.status === 'suspended').map((r) => r.id),
    );
    return page.map((run) => (waiting[run.id] ? { ...run, waiting: waiting[run.id] } : run));
  }

  /** Exact per status up to {@link WORKFLOWS_LIST_CAP}; origin is always unknown (`null`). */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const rows: RunFacetRow[] = [];
    for (const status of ALL_OFFICIAL) {
      const count = (await this.matching({ ...query, statuses: [TO_RUN_STATUS[status]] }, [status]))
        .length;
      if (count > 0) rows.push({ status: TO_RUN_STATUS[status], origin: null, count });
    }
    return rows;
  }

  /** No value enumeration in the official store: the console's pickers stay free-text. */
  async runValueFacets(): Promise<RunValueFacetRow[]> {
    return [];
  }

  async waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    const out: Record<string, RunWaiting> = {};
    await Promise.all(
      runIds.map(async (id) => {
        const waiting = waitingOf((await this.client.getStatus(id))?.waits);
        if (waiting) out[id] = waiting;
      }),
    );
    return out;
  }

  /** The official engine has no transport to report on. */
  async workerHealth(): Promise<GroupHealth[]> {
    return [];
  }

  async cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    try {
      const result = opts?.compensate
        ? await this.client.cancel(runId, 'cancelled from the durable console')
        : await this.client.terminate(runId, 'terminated from the durable console');
      return { runId, status: TO_RUN_STATUS[result.status] };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async retry(runId: string): Promise<RunResult | null> {
    try {
      const instance = await this.client.retry(runId);
      return { runId, status: TO_RUN_STATUS[instance.status] };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** No breakpoints in the official engine. */
  async continue(): Promise<RunResult | null> {
    return null;
  }

  /** No remote dispatch in the official engine, so nothing is ever lost in one. */
  async redispatchPending(): Promise<(RunResult & { redispatched: number }) | null> {
    return null;
  }

  async retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    const instance = await this.client.getStatus(runId);
    if (!instance) return null;
    const started = await this.client.start(instance.workflow, input as never, {
      version: instance.version,
    });
    return { runId: started.id };
  }

  /** Events of the instances THIS process's worker runs (the official events are in-process). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    const subscription = this.events.events$.subscribe((event) => {
      if (event.id !== runId) return;
      const mapped = toEngineEvent(event);
      if (mapped) onEvent(mapped);
    });
    return () => subscription.unsubscribe();
  }

  private async matching(
    query: RunQuery,
    official?: WorkflowStatus[],
  ): Promise<WorkflowInstance[]> {
    const statuses =
      official ??
      (query.statuses
        ? toOfficialStatuses(query.statuses)
        : query.status
          ? toOfficialStatuses([query.status])
          : undefined);
    if (statuses && statuses.length === 0) return [];
    const workflows = query.workflows ?? (query.workflow ? [query.workflow] : undefined);
    const exclude = new Set(query.excludeWorkflows ?? []);
    const reads = workflows ? workflows.map((workflow) => ({ workflow })) : [{}];
    const all: WorkflowInstance[] = [];
    for (const read of reads) {
      all.push(
        ...(await this.client.list({
          ...read,
          ...(statuses ? { status: statuses } : {}),
          limit: WORKFLOWS_LIST_CAP,
        })),
      );
    }
    return all.filter(
      (i) =>
        !exclude.has(i.workflow) &&
        (query.updatedAfter === undefined || i.updatedAt > query.updatedAfter),
    );
  }
}
