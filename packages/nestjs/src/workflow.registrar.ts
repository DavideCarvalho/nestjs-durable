import {
  DURABLE_OPTIONS_CANONICAL,
  STATE_STORE_CANONICAL,
  type StateStore,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
  parseDuration,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { getOnEvents, getWorkflowMeta, isDeadLetterHandler } from './decorators';
import type { DurableModuleOptions } from './durable.module';
import { entityConfigFor, getEntityMeta } from './entity';
import { classValidatorInput } from './input-validation';
import { type DurableStepInterceptor, isStepInterceptor } from './step-interceptor';

interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/**
 * Ensures the schema (auto-schema) and registers `@Workflow` providers on init, resumes runs left
 * incomplete by a previous process once booted, and drains in-flight runs on shutdown.
 *
 * For the shutdown drain to fire, enable Nest's shutdown hooks: `app.enableShutdownHooks()`.
 */
@Injectable()
export class WorkflowRegistrar
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly engine: WorkflowEngine,
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Only the worker role recovers runs left incomplete by a crash/deploy. A dashboard-only
    // instance (`worker: false`) must not pick up and re-run workflows — leave that to the workers.
    if (this.options.worker === false) return;
    await this.engine.recoverIncomplete();
  }

  /** On deploy/shutdown: stop picking up new runs and wait for in-flight ones to settle, then close
   *  the transport(s) so the broker workers stop consuming and connections are released. Closing
   *  AFTER the drain keeps the transport alive while in-flight runs dispatch/await their remote steps. */
  async onApplicationShutdown(): Promise<void> {
    await this.engine.drain(this.options.shutdownTimeoutMs);
    const transports = [
      this.options.transport,
      ...(this.options.transports ?? []).map((t) => t.transport),
    ];
    await Promise.allSettled(transports.map((t) => t?.close?.()));
  }

  async onModuleInit(): Promise<void> {
    if (this.options.autoSchema !== false) {
      await this.store.ensureSchema?.();
    }
    // Maps a workflow name to the workflow its dead runs route to. Built from each `@Workflow`'s
    // inline `@DeadLetter()` method (preferred) or its `deadLetterWorkflow` reference; the
    // module-level `deadLetterWorkflow` is the fallback applied in the onDead listener below.
    const deadLetterByWorkflow = new Map<string, string>();

    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;
      if (isStepInterceptor(instance.constructor)) {
        const interceptor = instance as DurableStepInterceptor;
        this.engine.use((invocation, next) => interceptor.intercept(invocation, next));
      }
      const entityMeta = getEntityMeta(instance.constructor);
      if (entityMeta) {
        this.engine.registerEntity(entityMeta.name, entityConfigFor(instance.constructor));
        continue; // an @Entity is not a @Workflow
      }
      const meta = getWorkflowMeta(instance.constructor);
      if (!meta) continue;
      const workflow = instance as WorkflowInstance;
      if (typeof workflow.run !== 'function') {
        throw new Error(`@Workflow ${meta.name} must define a run(ctx, input) method`);
      }
      // Input validation: a custom `validateInput` wins; otherwise build one from the class-validator
      // `inputSchema` DTO (lazy — class-validator is only required if a workflow uses inputSchema).
      const validateInput =
        meta.validateInput ??
        (meta.inputSchema ? classValidatorInput(meta.inputSchema) : undefined);
      const eventBatch = meta.debounce
        ? ({ mode: 'debounce', windowMs: parseDuration(meta.debounce) } as const)
        : meta.batch
          ? ({
              mode: 'batch',
              maxSize: meta.batch.maxSize,
              windowMs: parseDuration(meta.batch.within),
            } as const)
          : undefined;
      this.engine.register(meta.name, meta.version, (ctx, input) => workflow.run(ctx, input), {
        tags: meta.tags,
        singleton: meta.singleton,
        executionTimeout: meta.executionTimeout,
        validateInput,
        onEvent: getOnEvents(meta, instance.constructor),
        eventBatch,
      });

      const inline = this.findDeadLetterHandler(instance);
      if (inline && meta.deadLetterWorkflow) {
        // Two dead-letter targets for one workflow is ambiguous config, not a precedence question —
        // fail fast at boot rather than silently picking one.
        throw new Error(
          `@Workflow ${meta.name} declares both an inline @DeadLetter() method and a deadLetterWorkflow option. Use one: the inline handler, or the reference.`,
        );
      }
      if (inline) {
        // The inline handler is itself a durable workflow, registered as `<name>.dlq`, so it gets
        // checkpointing and a dashboard run linked to the dead run via the `dlq:<runId>` id.
        const dlqName = `${meta.name}.dlq`;
        this.engine.register(dlqName, meta.version, inline);
        deadLetterByWorkflow.set(meta.name, dlqName);
      } else if (meta.deadLetterWorkflow) {
        deadLetterByWorkflow.set(meta.name, workflowName(meta.deadLetterWorkflow));
      }
    }

    this.installDeadLetterRouting(deadLetterByWorkflow);
  }

  /** Returns the instance's `@DeadLetter()` method bound to the instance, or undefined if none. */
  private findDeadLetterHandler(instance: object): WorkflowFn | undefined {
    const prototype = Object.getPrototypeOf(instance);
    for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
      const method = (instance as Record<string, unknown>)[methodName];
      if (typeof method === 'function' && isDeadLetterHandler(method)) {
        return (ctx, input) => method.call(instance, ctx, input);
      }
    }
    return undefined;
  }

  /**
   * Installs a single onDead listener that routes a dead run to its workflow's handler (from the
   * map) or the module-level `deadLetterWorkflow` default. The handler is started idempotently with
   * a `dlq:<runId>` id, so re-recovery never double-dispatches.
   */
  private installDeadLetterRouting(byWorkflow: Map<string, string>): void {
    const fallback = this.options.deadLetterWorkflow
      ? workflowName(this.options.deadLetterWorkflow)
      : undefined;
    if (byWorkflow.size === 0 && !fallback) return;
    this.engine.onDead((run: WorkflowRun) => {
      const target = byWorkflow.get(run.workflow) ?? fallback;
      if (!target) return;
      void this.engine
        .start(
          target,
          { deadRunId: run.id, workflow: run.workflow, input: run.input, error: run.error },
          `dlq:${run.id}`,
        )
        .catch(() => undefined);
    });
  }
}
