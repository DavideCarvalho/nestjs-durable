import type { StepInvocation } from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';

export const STEP_INTERCEPTOR_METADATA = Symbol('nestjs-durable:step-interceptor');

/**
 * The shape a `@StepInterceptor()` provider must implement: `intercept(invocation, next)` wraps the
 * real execution of every local `ctx.step` (call `next()` to run the step body / next interceptor,
 * and return — or transform — its result). The engine-level {@link StepInterceptor} primitive, with
 * NestJS dependency injection.
 */
export interface DurableStepInterceptor {
  intercept(invocation: StepInvocation, next: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Marks an `@Injectable()` class as a durable step interceptor. The module discovers it on boot and
 * registers its `intercept` method with the engine (so it can inject loggers/tracers/etc.). First
 * declared is outermost. Interceptors fire only when a step actually executes, never on replay.
 */
export function StepInterceptor(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(STEP_INTERCEPTOR_METADATA, true, target);
  };
}

// biome-ignore lint/complexity/noBannedTypes: matches reflect-metadata's class target type
export function isStepInterceptor(target: Function): boolean {
  return Reflect.getMetadata(STEP_INTERCEPTOR_METADATA, target) === true;
}
