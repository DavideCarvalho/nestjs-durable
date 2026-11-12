import { randomUUID } from 'node:crypto';
import {
  FatalError,
  type StartOptions,
  type WorkflowClass,
  WorkflowEngine,
  type WorkflowInputOf,
  type WorkflowRef,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, Inject, Injectable, Module, Optional } from '@nestjs/common';
import {
  NonRetryableMessageError,
  OnOutboxMessage,
  Outbox,
  type OutboxHandlerContext,
} from '@nestjs/outbox';

/** Default outbox topic the durable messages are written to. */
export const DURABLE_OUTBOX_TOPIC = 'nestjs-durable';
/** Default inbox consumer name of the handler that starts/signals runs. */
export const DURABLE_OUTBOX_CONSUMER = 'nestjs-durable';

/** Options for {@link DurableOutboxModule.forRoot}. */
export interface DurableOutboxModuleOptions {
  /** The outbox topic durable's messages use. Default {@link DURABLE_OUTBOX_TOPIC}. */
  topic?: string;
  /**
   * The `@OnOutboxMessage` consumer name its inbox entries are recorded under. Keep it stable: a new
   * name makes every past message look new. Default {@link DURABLE_OUTBOX_CONSUMER}.
   */
  consumer?: string;
}

/** `StartOptions` as they travel in an outbox message: JSON-safe (`startAt` as epoch ms). */
type WireStartOptions = Omit<StartOptions, 'startAt'> & { startAt?: number };

/** The payload of a durable outbox message. Versioned so a later shape can coexist. */
export type DurableOutboxPayload =
  | {
      v: 1;
      kind: 'start';
      workflow: string;
      input: unknown;
      runId: string;
      opts?: WireStartOptions;
    }
  | { v: 1; kind: 'signal'; token: string; payload: unknown };

/** {@link DurableOutbox.start} options: `StartOptions` plus the run id. */
export interface DurableOutboxStartOptions extends StartOptions {
  /**
   * The run's id. Optional: when omitted, a random id is chosen NOW and written into the message,
   * so every redelivery starts the same run (the engine's start is idempotent by run id).
   */
  runId?: string;
  /** Outbox ordering key (messages sharing it publish in order). */
  key?: string;
}

/** {@link DurableOutbox.signal} options. */
export interface DurableOutboxSignalOptions {
  /** Outbox ordering key; defaults to the token, so signals to one token arrive in order. */
  key?: string | null;
  /** The outbox message id (dedupe key of the inbox). Default: the fresh UUIDv7 `Outbox.add` assigns. */
  id?: string;
}

const OPTIONS = Symbol('DURABLE_OUTBOX_OPTIONS');

interface ResolvedOptions {
  topic: string;
  consumer: string;
}

/**
 * Starts and signals durable runs INSIDE the application's database transaction, through
 * `@nestjs/outbox`: the message commits or rolls back with your business writes, and the relay
 * delivers it to the engine after commit.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.insert(orders).values(order);
 *   await durableOutbox.start(tx, CheckoutWorkflow, { orderId: order.id }, { runId: `checkout:${order.id}` });
 * });
 * ```
 */
@Injectable()
export class DurableOutbox<Tx = unknown> {
  constructor(
    private readonly outbox: Outbox<Tx>,
    @Inject(OPTIONS) private readonly options: ResolvedOptions,
    @Optional() private readonly engine?: WorkflowEngine,
  ) {}

  /**
   * Write a "start this run" message through `tx`. Resolves the run id (yours, or the one chosen
   * here). A workflow class is written by its registered NAME, so the message stays serializable
   * and is delivered to whichever instance runs the relay.
   */
  start<C extends WorkflowClass>(
    tx: Tx,
    workflow: C,
    input: WorkflowInputOf<C>,
    opts?: DurableOutboxStartOptions,
  ): Promise<{ runId: string }>;
  start(
    tx: Tx,
    workflow: string,
    input: unknown,
    opts?: DurableOutboxStartOptions,
  ): Promise<{ runId: string }>;
  async start(
    tx: Tx,
    workflow: WorkflowRef,
    input: unknown,
    opts: DurableOutboxStartOptions = {},
  ): Promise<{ runId: string }> {
    const { runId = randomUUID(), key, startAt, ...rest } = opts;
    // The relay starts the run after commit, often from a poller with no request: record the
    // request's tenant now (data tenancy), unless the caller chose one.
    const tenant = rest.tenantId === undefined ? this.engine?.contextTenant?.() : undefined;
    const wireOpts: WireStartOptions = {
      ...rest,
      ...(tenant
        ? { tenantId: tenant.id, ...(tenant.kind !== undefined ? { tenantKind: tenant.kind } : {}) }
        : {}),
      ...(startAt !== undefined
        ? { startAt: startAt instanceof Date ? startAt.getTime() : startAt }
        : {}),
    };
    const payload: DurableOutboxPayload = {
      v: 1,
      kind: 'start',
      workflow: workflowName(workflow),
      input,
      runId,
      ...(Object.keys(wireOpts).length > 0 ? { opts: wireOpts } : {}),
    };
    await this.outbox.add(tx, { topic: this.options.topic, payload, key: key ?? null });
    return { runId };
  }

  /**
   * Write a "deliver this signal" message through `tx`: after commit, the payload is delivered to
   * the run waiting on `token` (`ctx.waitForSignal(token)`), or buffered for it like
   * `WorkflowService.signal`.
   */
  async signal(
    tx: Tx,
    token: string,
    payload: unknown,
    opts: DurableOutboxSignalOptions = {},
  ): Promise<void> {
    const message: DurableOutboxPayload = { v: 1, kind: 'signal', token, payload };
    await this.outbox.add(tx, {
      topic: this.options.topic,
      payload: message,
      key: opts.key === undefined ? token : opts.key,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
    });
  }

  /** Poll the relay now (after your transaction commits) instead of waiting for its interval. */
  notify(): void {
    this.outbox.notify();
  }
}

/**
 * Applies a durable outbox message to the engine. Exported for tests and for a remote consumer that
 * receives the envelope over a broker; the module's `@OnOutboxMessage` handler calls it.
 *
 * A start is idempotent by run id (an existing run is a no-op success), so a redelivery never starts
 * a second run. An input the workflow rejects (a `FatalError` such as `SchemaValidationError`), an
 * unknown payload shape, dead-letters at once instead of being retried.
 */
export async function applyDurableOutboxMessage(
  engine: WorkflowEngine,
  message: DurableOutboxPayload,
): Promise<void> {
  if (!message || message.v !== 1) {
    throw new NonRetryableMessageError(
      `unsupported durable outbox payload: ${JSON.stringify(message)?.slice(0, 200)}`,
    );
  }
  try {
    if (message.kind === 'start') {
      await engine.start(
        message.workflow,
        message.input,
        message.runId,
        message.opts as StartOptions,
      );
      return;
    }
    if (message.kind === 'signal') {
      await engine.signal(message.token, message.payload);
      return;
    }
  } catch (error) {
    if (error instanceof FatalError) {
      throw new NonRetryableMessageError(error.message, { cause: error });
    }
    throw error;
  }
  throw new NonRetryableMessageError(
    `unknown durable outbox message kind: ${(message as { kind?: unknown }).kind}`,
  );
}

/** The consumer side; one fresh subclass per registration carries that registration's topic. */
@Injectable()
export class DurableOutboxHandler {
  constructor(private readonly engine: WorkflowEngine) {}

  handle(payload: DurableOutboxPayload, _ctx?: OutboxHandlerContext): Promise<void> {
    return applyDurableOutboxMessage(this.engine, payload);
  }
}

function handlerFor(options: ResolvedOptions): typeof DurableOutboxHandler {
  const derived = class extends DurableOutboxHandler {};
  Object.defineProperty(derived, 'name', { value: DurableOutboxHandler.name });
  // Re-declare the method on the subclass so the `@OnOutboxMessage` metadata (stored on the function
  // object) belongs to THIS registration only, never to the shared base method.
  const handle = function (
    this: DurableOutboxHandler,
    payload: DurableOutboxPayload,
    ctx?: OutboxHandlerContext,
  ) {
    return DurableOutboxHandler.prototype.handle.call(this, payload, ctx);
  };
  const descriptor: PropertyDescriptor = { value: handle, writable: true, configurable: true };
  OnOutboxMessage(options.topic, { consumer: options.consumer })(
    derived.prototype,
    'handle',
    descriptor,
  );
  Object.defineProperty(derived.prototype, 'handle', descriptor);
  return derived;
}

/**
 * Wires durable runs to `@nestjs/outbox`. Import it next to `OutboxModule.forRoot()` (which owns the
 * store, relay, retries and dead letters) and `DurableModule.forRoot()`.
 */
@Module({})
export class DurableOutboxModule {
  static forRoot(options: DurableOutboxModuleOptions = {}): DynamicModule {
    const resolved: ResolvedOptions = {
      topic: options.topic ?? DURABLE_OUTBOX_TOPIC,
      consumer: options.consumer ?? DURABLE_OUTBOX_CONSUMER,
    };
    return {
      module: DurableOutboxModule,
      providers: [{ provide: OPTIONS, useValue: resolved }, DurableOutbox, handlerFor(resolved)],
      exports: [DurableOutbox],
    };
  }
}
