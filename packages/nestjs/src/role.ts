import type { DurableModuleOptions } from './durable.module';

/**
 * True for the **operator** role — `store` is set (with or without a co-located `connection`). See
 * {@link DurableModuleOptions} for the full role matrix. Kept in its own module (rather than
 * `durable.module.ts`) so the poller/registrar classes can import it as a plain VALUE without a
 * circular value dependency on the module that also imports them as providers.
 */
export function isOperatorRole(options: DurableModuleOptions): boolean {
  return options.store !== undefined;
}

/**
 * True when an operator instance actively DRIVES runs — polls pending, recovers crashed, resumes due
 * timers, sweeps timeouts, prunes retention, consumes local steps — as opposed to a read-only/
 * dashboard replica (`drive: false`) that mounts the store/dashboard but leaves driving to another
 * instance. Meaningless (`false`) outside the operator role. Defaults to `true` for an operator.
 */
export function isDrivingOperator(options: DurableModuleOptions): boolean {
  return isOperatorRole(options) && options.drive !== false;
}
