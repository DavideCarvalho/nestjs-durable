import { type EntityHandler, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import 'reflect-metadata';

export const ENTITY_METADATA = Symbol('nestjs-durable:entity');
export const ENTITY_ON_METADATA = Symbol('nestjs-durable:entity-on');

/**
 * Marks an `@Injectable()` class as a **durable entity** (a virtual object): its `@On(op)` methods run
 * serialized per key over the instance's fields as durable state. e.g.
 *
 * ```ts
 * @Entity({ name: 'cart' }) @Injectable()
 * class Cart { items: Item[] = []; @On('add') add(i: Item) { this.items.push(i); } @On('list') list() { return this.items; } }
 * ```
 *
 * The class must be **constructible with no arguments** (a fresh instance is the initial state per key)
 * — keep entities pure state, no DI. Drive them with `EntityService` or `ctx.signalEntity`/`callEntity`.
 */
export function Entity(options: { name: string }): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(ENTITY_METADATA, options, target);
  };
}

/** Marks an entity method as the handler for operation `op`. */
export function On(op: string): MethodDecorator {
  return (target, propertyKey) => {
    // biome-ignore lint/complexity/noBannedTypes: reflect-metadata keys on the class constructor
    const ctor = (target as { constructor: Function }).constructor;
    const ops = (Reflect.getMetadata(ENTITY_ON_METADATA, ctor) as Map<string, string>) ?? new Map();
    ops.set(op, propertyKey as string);
    Reflect.defineMetadata(ENTITY_ON_METADATA, ops, ctor);
  };
}

// biome-ignore lint/complexity/noBannedTypes: matches reflect-metadata's class target type
export function getEntityMeta(target: Function): { name: string } | undefined {
  return Reflect.getMetadata(ENTITY_METADATA, target) as { name: string } | undefined;
}

/**
 * Build the engine `EntityConfig` for a discovered `@Entity` class: a fresh instance per key, and
 * handlers that rehydrate the class prototype onto the (serialized) state before dispatching the op,
 * so methods work after replay.
 */
// biome-ignore lint/complexity/noBannedTypes: a class constructor
export function entityConfigFor(ctor: Function): {
  initialState: () => object;
  handlers: Record<string, EntityHandler>;
} {
  const ops = (Reflect.getMetadata(ENTITY_ON_METADATA, ctor) as Map<string, string>) ?? new Map();
  const Cls = ctor as new () => Record<string, (arg: unknown) => unknown>;
  const handlers: Record<string, EntityHandler> = {};
  for (const [op, method] of ops) {
    handlers[op] = (state, arg) => {
      Object.setPrototypeOf(state as object, Cls.prototype); // re-attach methods to the plain state
      const fn = (state as Record<string, ((a: unknown) => unknown) | undefined>)[method];
      if (typeof fn !== 'function') throw new Error(`entity handler "${method}" is not a method`);
      return fn.call(state, arg);
    };
  }
  return { initialState: () => new Cls(), handlers };
}

/** Inject this to drive durable entities from outside a workflow. */
@Injectable()
export class EntityService {
  constructor(private readonly engine: WorkflowEngine) {}

  /** Send an operation to an entity (fire-and-forget; ordered + exactly-once per key). */
  signal(name: string, key: string, op: string, arg?: unknown): Promise<void> {
    return this.engine.signalEntity(name, key, op, arg);
  }

  /** Read an entity's current durable state (or undefined if it has none yet). */
  getState<S = unknown>(name: string, key: string): Promise<S | undefined> {
    return this.engine.getEntityState<S>(name, key);
  }
}
