import {
  DURABLE_OPTIONS_CANONICAL,
  type StepLogger,
  TRANSPORT_CANONICAL,
  type Transport,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { scanSteps } from './discovery-helpers';
import type { DurableModuleOptions } from './durable.module';
import { isCoLocatedWorker, isDrivingOperator } from './role';

/** A transport that can run step handlers in-process (e.g. the event-emitter transport). */
interface LocalTaskHandling {
  handle(
    name: string,
    fn: (input: unknown, log: StepLogger) => Promise<unknown> | unknown,
    /** Isolation partition to SERVE — the queue token is `tenantGroup(sanitizeQueueToken(name),
     *  partition)`. Omitted (or undefined) keeps the transport's own constructor partition. */
    partition?: string | undefined,
  ): void;
}

function supportsHandle(transport: unknown): transport is LocalTaskHandling {
  return typeof (transport as LocalTaskHandling | null)?.handle === 'function';
}

/**
 * Discovers `@Step` methods and registers them — under their RESOLVED name (derived `Class.method`
 * for a bare `@Step()`, or the explicit override) — as step handlers on the configured transport,
 * when that transport runs handlers in-process, on a driving operator with no step consumer of its
 * own. With a queue/remote transport the handlers live in the worker process instead, and a
 * co-located worker (`store` + `connection`) serves them through its in-app worker runtime, so there
 * is nothing to wire here in either case: each step queue has exactly one consumer.
 *
 * **Context re-hydration (consume side).** DurableModule's produce side auto-feeds an opaque carrier
 * (`Context.serialize()`, filtered by the app's `carrier: [...]` allowlist) from
 * `@dudousxd/nestjs-context` onto each dispatched
 * `RemoteTask.context` and `WorkflowTask.context` (see DurableModule). A worker role restores it
 * around each dispatched turn and step through the worker runtime's `rehydrate` bridge
 * (`Context.deserialize`, see `context-runtime.ts`). A handler registered HERE, on an in-process
 * transport, gets no carrier: the in-process `StepHandler` contract is `(input, log)` and the engine
 * never surfaces `task.context` to it; only the tenant is restored there, by the tenancy bridge.
 */
@Injectable()
export class DurableStepRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    @Inject(TRANSPORT_CANONICAL) private readonly transport: Transport | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  onModuleInit(): void {
    // A non-driving operator (`drive: false`) or a thin worker (no `store`) must not consume the
    // queue — receiving and running step tasks locally is exactly the driving-operator role we're
    // switching off here (a thin worker registers its steps via `ThinStepRegistrar` instead).
    if (!isDrivingOperator(this.options)) return;
    // A co-located worker (`store` + `connection`) consumes every `@Step` queue through its in-app
    // worker runtime, which restores the task's context carrier and applies the step consumer's
    // concurrency and lock settings. Registering here too would start a second consumer on the
    // same queue, racing it for each job.
    if (isCoLocatedWorker(this.options)) return;
    if (!supportsHandle(this.transport)) return;
    const transport = this.transport;

    // Forward the step logger as a second arg; methods that only declare `(input)` ignore it.
    // The partition is the node's own tenant axis (`topology: 'control-plane'` with a `partition`
    // resolves it, see `resolveTopology`): this engine DISPATCHES a tenant run's steps to
    // `<name>@<tenant>`, so its in-process handlers must SERVE that same token. Undefined on a global
    // operator — the bare token, byte-identical to before.
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      transport.handle(meta.name, handler, this.options.partition),
    );
  }
}
