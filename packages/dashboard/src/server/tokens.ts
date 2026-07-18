import { RunGateway } from '@dudousxd/nestjs-durable-core';

/**
 * @deprecated Inject the `RunGateway` abstract class directly (it is its own DI token). This alias
 * is kept for internal back-compat only.
 *
 * The bound `RunGateway` port is owned by `@dudousxd/nestjs-durable-core` — a required peer dep of
 * both this dashboard package and `@dudousxd/nestjs-durable`. Since core's `RunGateway` is now an
 * abstract class, that single class is the shared DI token across packages: both bind and inject the
 * same imported class, so the previous `Symbol.for` value-sharing hack (which existed only because
 * the dashboard cannot import from `@dudousxd/nestjs-durable`) is no longer needed.
 */
export const RUN_GATEWAY = RunGateway;
