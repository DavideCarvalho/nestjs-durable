/**
 * The origin (see {@link import('./interfaces').WorkflowRun.origin}) stamped onto runs of the
 * workflows this package registers ITSELF — the built-in `__entity` runner behind durable entities
 * and the `__evt_debounce` / `__evt_batch` `onEvent` accumulators. It is this package's npm `name`,
 * so a console's origin facet files that engine plumbing under the engine instead of mixing it into
 * the app's own runs (or leaving it unattributed). Pinned against `package.json` by a test.
 */
export const CORE_ORIGIN = '@dudousxd/nestjs-durable-core';
