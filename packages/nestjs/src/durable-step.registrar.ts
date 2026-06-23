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

/** A transport that can run step handlers in-process (e.g. the event-emitter transport). */
interface LocalTaskHandling {
  handle(name: string, fn: (input: unknown, log: StepLogger) => Promise<unknown> | unknown): void;
}

function supportsHandle(transport: unknown): transport is LocalTaskHandling {
  return typeof (transport as LocalTaskHandling | null)?.handle === 'function';
}

/**
 * Discovers `@DurableStep` methods and registers them as step handlers on the configured
 * transport, when that transport runs handlers in-process. With a queue/remote transport the
 * handlers live in the worker process instead, so there is nothing to wire here.
 *
 * **Context re-hydration (consume side) is the consumer's responsibility.** DurableModule's
 * produce side auto-feeds an opaque carrier (`{ traceId, tenantId, userRef }`) from
 * `@dudousxd/nestjs-context` onto each dispatched `RemoteTask.context` (see DurableModule). A worker
 * that wants its `@DurableStep` reads to SEE the originating context must re-establish it from
 * `task.context`. We do NOT do this here because: (a) re-hydration needs nestjs-context's module-level
 * `Context.deserialize(carrier, fn)` at runtime, and it is an OPTIONAL peer we must not hard-import;
 * and (b) the in-process `StepHandler` contract is `(input, log)` — the engine never surfaces
 * `task.context` to the handler closure, so wrapping it here would require widening the core
 * transport/handler signature (a non-additive cross-cutting change). Instead, a worker that consumes
 * the carrier should wrap its handler with `Context.deserialize(task.context, () => handler(...))`
 * from its own transport/worker bootstrap, where `task` is in scope.
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
    // A dashboard/dispatch-only instance (`worker: false`) must not consume the queue — receiving
    // and running step tasks is exactly the worker role we're switching off here.
    if (this.options.worker === false) return;
    if (!supportsHandle(this.transport)) return;
    const transport = this.transport;

    // Forward the step logger as a second arg; methods that only declare `(input)` ignore it.
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      transport.handle(meta.name, handler),
    );
  }
}
