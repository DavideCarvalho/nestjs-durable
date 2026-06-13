import { DURABLE_OPTIONS, TRANSPORT, type Transport } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { getDurableStepMeta } from './decorators';
import type { DurableModuleOptions } from './durable.module';

/** A transport that can run step handlers in-process (e.g. the event-emitter transport). */
interface LocalTaskHandling {
  handle(name: string, fn: (input: unknown) => Promise<unknown>): void;
}

function supportsHandle(transport: unknown): transport is LocalTaskHandling {
  return typeof (transport as LocalTaskHandling | null)?.handle === 'function';
}

/**
 * Discovers `@DurableStep` methods and registers them as step handlers on the configured
 * transport, when that transport runs handlers in-process. With a queue/remote transport the
 * handlers live in the worker process instead, so there is nothing to wire here.
 */
@Injectable()
export class DurableStepRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    @Inject(TRANSPORT) private readonly transport: Transport | null,
    @Inject(DURABLE_OPTIONS) private readonly options: DurableModuleOptions,
  ) {}

  onModuleInit(): void {
    // A dashboard/dispatch-only instance (`worker: false`) must not consume the queue — receiving
    // and running step tasks is exactly the worker role we're switching off here.
    if (this.options.worker === false) return;
    if (!supportsHandle(this.transport)) return;
    const transport = this.transport;

    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const method = instance[methodName];
        if (typeof method !== 'function') continue;
        const meta = getDurableStepMeta(method);
        if (!meta) continue;
        transport.handle(meta.name, (input) => instance[methodName](input));
      }
    }
  }
}
