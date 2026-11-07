import {
  RunGateway,
  type RunResult,
  type RunStatus,
  STATE_STORE_CANONICAL,
  type StartOptions,
  type StateStore,
  type StepError,
  type WorkflowClass,
  WorkflowEngine,
  type WorkflowInputOf,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import { WorkflowsRunGateway, toWorkflowRun } from '@dudousxd/nestjs-durable-workflows-gateway';
import { type DynamicModule, Inject, Injectable, Module } from '@nestjs/common';
import { WorkflowClient, WorkflowEvents, type WorkflowStatus } from '@nestjs/workflows';
import { StoreRunGateway } from '../store-run-gateway';
import { CombinedRunGateway } from './combined-run-gateway';

export { CombinedRunGateway } from './combined-run-gateway';

/** Which engine owns an instance id during the cutover. */
export type MigrationEngine = 'nestjs-durable' | '@nestjs/workflows';

/** An instance's state, in durable's terms, from whichever engine owns it. */
export interface MigrationStatus {
  engine: MigrationEngine;
  runId: string;
  workflow: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError | undefined;
}

/** The official statuses an instance still runs in (what a drain waits for). */
const UNFINISHED: WorkflowStatus[] = ['pending', 'running', 'suspended', 'compensating'];
const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled', 'dead'];

/**
 * Routes a client's calls during a cutover from `@nestjs/workflows` to nestjs-durable, when both
 * run side by side: new starts go to durable; `signal` / `cancel` / `getStatus` / `result` find the
 * instance in whichever engine owns its id, durable first. Instances never move between engines
 * (their journals differ): the official worker keeps finishing what it started.
 *
 * Signals follow the convention the migration codemod uses: the official `signal(name, payload,
 * { key })` is the durable token `<name>:<key>` (or `<name>` without a key).
 */
@Injectable()
export class MigrationClient {
  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore,
    private readonly official: WorkflowClient,
  ) {}

  /** Start a new instance, always on durable. */
  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string, opts?: StartOptions): Promise<RunResult>;
  start(
    workflow: string | WorkflowClass,
    input: unknown,
    runId: string = globalThis.crypto.randomUUID(),
    opts?: StartOptions,
  ): Promise<RunResult> {
    return this.engine.start(workflowName(workflow), input, runId, opts);
  }

  /** The engine that owns `runId`, or `null` when neither has it. */
  async owner(runId: string): Promise<MigrationEngine | null> {
    if (await this.store.getRun(runId)) return 'nestjs-durable';
    if (await this.official.getStatus(runId)) return '@nestjs/workflows';
    return null;
  }

  /**
   * Signal the instance `runId` waits on: durable gets the token `<signal>:<key>`, the official
   * engine `signal(signal, payload, { key, id })`. Resolves the owner, or `null` for an unknown id
   * (nothing is sent: a signal for nobody would be buffered for a later wait).
   */
  async signal(
    runId: string,
    signal: string,
    payload: unknown,
    opts: { key?: string; id?: string } = {},
  ): Promise<MigrationEngine | null> {
    const owner = await this.owner(runId);
    if (owner === 'nestjs-durable') {
      await this.engine.signal(opts.key ? `${signal}:${opts.key}` : signal, payload);
    } else if (owner === '@nestjs/workflows') {
      await this.official.signal(signal, payload as never, {
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
      });
    }
    return owner;
  }

  /**
   * Cancel `runId` where it runs. `compensate: true` runs the saga undo (official `cancel`);
   * otherwise it stops without compensating (official `terminate`).
   */
  async cancel(
    runId: string,
    opts: { compensate?: boolean } = {},
  ): Promise<MigrationStatus | null> {
    const owner = await this.owner(runId);
    if (owner === 'nestjs-durable') await this.engine.cancel(runId, opts);
    else if (owner === '@nestjs/workflows') {
      if (opts.compensate) await this.official.cancel(runId);
      else await this.official.terminate(runId);
    }
    return owner ? this.getStatus(runId) : null;
  }

  async getStatus(runId: string): Promise<MigrationStatus | null> {
    const run = await this.store.getRun(runId);
    if (run) {
      return {
        engine: 'nestjs-durable',
        runId,
        workflow: run.workflow,
        status: run.status,
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.error ? { error: run.error } : {}),
      };
    }
    const instance = await this.official.getStatus(runId);
    if (!instance) return null;
    const mapped = toWorkflowRun(instance);
    return {
      engine: '@nestjs/workflows',
      runId,
      workflow: instance.workflow,
      status: mapped.status,
      ...(mapped.output !== undefined ? { output: mapped.output } : {}),
      ...(mapped.error ? { error: mapped.error } : {}),
    };
  }

  /**
   * Wait for `runId` to finish where it runs and resolve its status (`completed` with `output`, or
   * `failed` / `cancelled` / `dead` with `error`). Never throws for a failed instance.
   */
  async result(runId: string, opts: { timeoutMs?: number } = {}): Promise<MigrationStatus> {
    const owner = await this.owner(runId);
    if (owner === 'nestjs-durable') {
      await this.engine.waitForRun(runId, {
        until: 'terminal',
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } else if (owner === '@nestjs/workflows') {
      await this.official
        .result(runId, opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {})
        .catch((error: unknown) => {
          // A failed / cancelled instance rejects with WorkflowFailedError: its status says so.
          if ((error as { name?: string })?.name !== 'WorkflowFailedError') throw error;
        });
    } else {
      throw new Error(`no instance ${runId} in nestjs-durable or @nestjs/workflows`);
    }
    const status = await this.getStatus(runId);
    if (!status || !TERMINAL.includes(status.status)) {
      throw new Error(`instance ${runId} did not finish`);
    }
    return status;
  }

  /**
   * How many instances the official engine still has to finish. The cutover is over when it is 0:
   * nothing starts there any more, so it only goes down.
   */
  async remainingOnOfficial(): Promise<number> {
    return (await this.official.list({ status: UNFINISHED, limit: 10_000 })).length;
  }
}

/** One console over both engines: durable's store gateway + the official gateway, combined. */
function combinedGateway(
  store: StateStore,
  engine: WorkflowEngine,
  client: WorkflowClient,
  events: WorkflowEvents,
): RunGateway {
  return new CombinedRunGateway(
    new StoreRunGateway(store, engine),
    new WorkflowsRunGateway(client, events),
  );
}

/**
 * The cutover from `@nestjs/workflows`: import next to `DurableModule.forRoot(...)` and
 * `WorkflowsModule.forRoot(...)`.
 *
 * - `forRoot()` provides {@link MigrationClient} (global).
 * - `console()` binds the dashboard to BOTH engines: pass it to the dashboard's `imports`,
 *   `DurableDashboardModule.forRoot({ imports: [DurableMigrationModule.console()] })`, where it takes
 *   precedence over the durable-only gateway `DurableModule` binds.
 */
@Module({})
export class DurableMigrationModule {
  static forRoot(): DynamicModule {
    return {
      module: DurableMigrationModule,
      global: true,
      providers: [MigrationClient],
      exports: [MigrationClient],
    };
  }

  static console(): DynamicModule {
    return {
      module: DurableMigrationConsoleModule,
      providers: [
        {
          provide: RunGateway,
          inject: [STATE_STORE_CANONICAL, WorkflowEngine, WorkflowClient, WorkflowEvents],
          useFactory: combinedGateway,
        },
      ],
      exports: [RunGateway],
    };
  }
}

@Module({})
class DurableMigrationConsoleModule {}
