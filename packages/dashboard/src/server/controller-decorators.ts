import 'reflect-metadata';
import type { Type } from '@nestjs/common';

/**
 * `@nestjs/authorization`'s `CAN_ANYONE_METADATA` key (what `@Can.Anyone()` writes), INLINED: the
 * constant is not exported, and this package takes no dependency on `@nestjs/authorization`. A drift
 * spec asserts that `Can.Anyone()` still writes exactly this key.
 */
export const CAN_ANYONE_METADATA = 'authorization:can-anyone';

/**
 * Marks a controller as open to `@nestjs/authorization`'s global `AuthorizationGuard`, which
 * otherwise denies every route that declares no `@Can()`. A `@Can()` passed through `decorators` is
 * still enforced: the official guard only treats `can-anyone` as open when the route declares no
 * requirement.
 */
export function markOpenToAuthorization(controller: Type): void {
  Reflect.defineMetadata(CAN_ANYONE_METADATA, true, controller);
}

/**
 * The controller one registration mounts. With no `decorators`, the shared class itself (unchanged
 * behaviour). With `decorators`, a FRESH subclass made for this registration only, so decorators
 * given to one `forRoot(...)` never stick to the next registration, another app in the same
 * process, or the exported class (the approach `@nestjs/mcp`'s `createMcpController` takes).
 *
 * The subclass inherits routes, filters, interceptors and constructor injection from the base.
 * Decorators are applied in array order, like `applyDecorators`.
 */
export function controllerFor<T extends Type>(
  base: T,
  decorators: readonly ClassDecorator[] | undefined,
): T {
  if (decorators === undefined || decorators.length === 0) return base;
  const derived = class extends base {};
  // Nest logs, `AuthorizationGuard` denial events and route tables read the class name.
  Object.defineProperty(derived, 'name', { value: base.name });
  markOpenToAuthorization(derived);
  let decorated: T = derived;
  for (const decorator of decorators) {
    // A class decorator may return a replacement class, as with `@Decorator() class X {}`.
    decorated = (decorator(decorated) as T | undefined) ?? decorated;
  }
  return decorated;
}
