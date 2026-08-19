import type { RunListItem } from '@dudousxd/nestjs-durable-core';

/**
 * A run as the CONSOLE'S LIST needs it: every field a row or its derived state reads, and none of the
 * payloads only the detail view opens.
 *
 * `input`, `output` and `error` are dropped. On a real control plane they dominate the response —
 * measured against a 9.5k-run deployment, `error` alone (stack traces on every failed run) was 63% of
 * a 12 MB listing — while no list row, and no `deriveRunState` input, ever reads them. The detail
 * endpoint (`GET runs/:id`) still returns the whole run, which is where those three are actually
 * rendered.
 */
export type RunListRow = Omit<RunListItem, 'input' | 'output' | 'error'>;

/** Project a gateway run down to {@link RunListRow}. Deletes rather than re-lists the kept fields, so
 *  a field added to `WorkflowRun` reaches the console automatically instead of being silently
 *  dropped by a projection nobody remembered to update. */
export function toRunListRow(run: RunListItem): RunListRow {
  const { input: _input, output: _output, error: _error, ...row } = run;
  return row;
}
