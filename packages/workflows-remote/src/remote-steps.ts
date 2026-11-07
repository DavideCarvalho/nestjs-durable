import type { RemoteTask, StepError, StepResult, Transport } from '@dudousxd/nestjs-durable-core';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type Duration,
  NonRetryableStepError,
  WorkflowClient,
  type WorkflowContext,
} from '@nestjs/workflows';

/** The signal a remote step's result is delivered on, keyed by its task id. */
export const REMOTE_RESULT = 'durable:remote-result';

/** How a remote step retries: unrolled attempts, each a fresh dispatch with a journaled backoff. */
export interface RemoteStepRetry {
  /** Total attempts, the first included. Default 3. */
  attempts?: number;
  /** Wait before the second attempt, in ms. Default 1000. */
  delay?: number;
  /** Growth of the wait per attempt. Default 2. */
  factor?: number;
  /** Cap for one wait, in ms. Default 300000 (5 min). */
  maxDelay?: number;
}

export interface RemoteStepOptions<I = unknown> {
  /** The worker group (queue) whose workers handle the step. */
  group: string;
  /** The step's input, sent as the task's `input` (JSON). */
  input?: I;
  /** How long one attempt may take, dispatch to result, before it counts as failed (retryable). */
  timeout: Duration;
  /** The handler name the worker registered. Default: `name`. */
  handler?: string;
  /** `false` or `1`: one attempt. A number: that many attempts. Default 3 attempts, 1s doubling. */
  retry?: number | false | RemoteStepRetry;
}

/** Thrown in the workflow when a remote step gives up (wrapped by `ctx.step` as a failed step). */
export class RemoteStepFailedError extends NonRetryableStepError {
  override name = 'RemoteStepFailedError';
  constructor(
    message: string,
    readonly remote: StepError | undefined,
  ) {
    super(message);
  }
}

/** The result payload a remote step's signal carries: durable's `StepResult` wire format. */
export type RemoteResultPayload = StepResult;

function retryOf(retry: RemoteStepOptions['retry']): Required<RemoteStepRetry> {
  const base = { attempts: 3, delay: 1_000, factor: 2, maxDelay: 300_000 };
  if (retry === false) return { ...base, attempts: 1 };
  if (typeof retry === 'number') return { ...base, attempts: Math.max(1, Math.floor(retry)) };
  return { ...base, ...retry, attempts: Math.max(1, Math.floor(retry?.attempts ?? base.attempts)) };
}

let current: RemoteSteps | undefined;

/**
 * Runs a step on a remote nestjs-durable worker (the Node `@dudousxd/durable-worker` or the Python
 * `durable_worker`) from a `@nestjs/workflows` workflow, through the transport given to
 * {@link DurableRemoteStepsModule.forRoot}.
 *
 * Each attempt is two journaled entries: a `ctx.step('<name>:dispatch#<n>')` that sends the task
 * (once: a replay never re-dispatches), then a `ctx.waitForAny('<name>:result#<n>')` of the result
 * signal against a `ctx.timer(timeout)`. The instance PARKS while the worker runs: no lease is held,
 * no worker slot is taken. A result arrives as the signal {@link REMOTE_RESULT} keyed by the task id
 * and deduplicated by it, so a redelivered result completes the step once.
 *
 * A remote failure the worker marks `retryable: false`, or the last attempt's failure or timeout,
 * fails the step (a `RemoteStepFailedError`, journaled as `<name>:failed`): catch it like any
 * `ctx.step` failure, or let it fail the instance (compensations run).
 */
export function remoteStep<O = unknown, I = unknown>(
  ctx: WorkflowContext,
  name: string,
  options: RemoteStepOptions<I>,
): Promise<O> {
  if (!current) {
    throw new Error(
      'remoteStep(): DurableRemoteStepsModule.forRoot({ transport }) is not imported in this application',
    );
  }
  return current.run<O, I>(ctx, name, options);
}

const OPTIONS = Symbol('DURABLE_REMOTE_STEPS_OPTIONS');

export interface DurableRemoteStepsOptions {
  /** A nestjs-durable `Transport` (BullMQ, SQS, the DB transport, the in-process event emitter…). */
  transport: Transport;
}

/** Injectable form of {@link remoteStep}; also consumes the transport's results. */
@Injectable()
export class RemoteSteps implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DurableRemoteSteps');
  private readonly transport: Transport;

  constructor(
    private readonly client: WorkflowClient,
    @Inject(OPTIONS) options: DurableRemoteStepsOptions,
  ) {
    this.transport = options.transport;
  }

  onModuleInit(): void {
    this.transport.onResult((result) => this.deliver(result));
    current = this;
  }

  onModuleDestroy(): void {
    if (current === this) current = undefined;
  }

  /**
   * A worker's result → the signal the waiting instance takes. `id` = the task id: a second copy
   * of the same result (an at-least-once broker) is stored once, and the first payload wins.
   */
  async deliver(result: StepResult): Promise<void> {
    await this.client.signal(REMOTE_RESULT, result as never, {
      key: result.stepId,
      id: result.stepId,
    });
  }

  async run<O = unknown, I = unknown>(
    ctx: WorkflowContext,
    name: string,
    options: RemoteStepOptions<I>,
  ): Promise<O> {
    const retry = retryOf(options.retry);
    const handler = options.handler ?? name;
    let last: StepError | undefined;
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      if (attempt > 1) {
        const wait = Math.min(retry.delay * retry.factor ** (attempt - 2), retry.maxDelay);
        await ctx.sleep(`${name}:backoff#${attempt}`, wait);
      }
      const taskId = `${ctx.workflowId}:${name}#${attempt}`;
      await ctx.step(
        `${name}:dispatch#${attempt}`,
        () => {
          const task: RemoteTask = {
            runId: ctx.workflowId,
            seq: attempt,
            name: handler,
            stepId: taskId,
            group: options.group,
            input: options.input,
            attempt,
          };
          return this.transport.dispatch(task).then(() => taskId);
        },
        // A dispatch that fails to reach the broker is retried by the official step policy.
      );
      const outcome = await ctx.waitForAny(`${name}:result#${attempt}`, {
        result: ctx.signalWait<RemoteResultPayload>(REMOTE_RESULT, { key: taskId }),
        timeout: ctx.timer(options.timeout),
      });
      if (outcome.key === 'result') {
        const result = outcome.value as RemoteResultPayload;
        if (result.status === 'completed') return result.output as O;
        last = result.error ?? { message: 'remote step failed' };
        if (last.retryable === false) break;
        continue;
      }
      last = {
        message: `remote step ${name} timed out after ${String(options.timeout)} (attempt ${attempt})`,
      };
    }
    const reason = last;
    const message = `remote step ${name} failed: ${reason?.message ?? 'unknown error'}`;
    // Journaled as a failed step, so the failure shows (and replays) like any step's.
    return ctx.step(
      `${name}:failed`,
      () => {
        throw new RemoteStepFailedError(message, reason);
      },
      { retry: false },
    ) as Promise<O>;
  }
}

/**
 * Remote steps for `@nestjs/workflows`. Import next to `WorkflowsModule` (global, which provides
 * `WorkflowClient`); the transport is the same one durable's workers consume.
 */
@Module({})
export class DurableRemoteStepsModule {
  static forRoot(options: DurableRemoteStepsOptions): DynamicModule {
    return {
      module: DurableRemoteStepsModule,
      providers: [{ provide: OPTIONS, useValue: options }, RemoteSteps],
      exports: [RemoteSteps],
    };
  }
}
