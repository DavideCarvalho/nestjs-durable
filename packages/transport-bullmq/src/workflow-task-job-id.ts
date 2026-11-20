/**
 * BullMQ job id of a workflow task, so `workflowTaskState` can find the job again. BullMQ refuses a
 * `:` in a custom id, so the `taskId` is escaped one-to-one (`_` to `_u`, then `:` to `_c`): two task
 * ids never share a job id.
 *
 * BullMQ silently ignores an `add` whose id an existing job already holds. That is safe only because
 * the engine mints a fresh `taskId` for every dispatch and a workflow-task job is removed once it
 * completes or fails (`removeOnComplete` and `removeOnFail` true in `jobOptions`): keep both, or a
 * dispatch could be dropped.
 */
export function workflowTaskJobId(taskId: string): string {
  return `wf-${taskId.replace(/_/g, '_u').replace(/:/g, '_c')}`;
}
