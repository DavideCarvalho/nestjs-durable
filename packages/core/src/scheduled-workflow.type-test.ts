/**
 * Compile-time checks for `ScheduledWorkflow`'s class form. Never run; `tsc` fails if the types drift.
 */
import type { ScheduledWorkflow } from './scheduler';

class ReportWorkflow {
  async run(_ctx: unknown, input: { region: string }): Promise<string> {
    return input.region;
  }
}

export const _classTypesInput: ScheduledWorkflow<typeof ReportWorkflow> = {
  key: 'report',
  workflow: ReportWorkflow,
  input: { region: 'eu' },
  everyMs: 60_000,
};

export const _classRejectsWrongInput: ScheduledWorkflow<typeof ReportWorkflow> = {
  key: 'report',
  workflow: ReportWorkflow,
  // @ts-expect-error `input` is checked against ReportWorkflow.run's input
  input: { region: 1 },
  everyMs: 60_000,
};

export const _nameTakesAnyInput: ScheduledWorkflow = {
  key: 'beat',
  workflow: 'beat',
  input: { anything: true },
  cron: '0 7 * * *',
};

// The unannotated form mixes names and classes in one list, as `DurableModule` takes it.
export const _mixedList: ScheduledWorkflow[] = [
  { key: 'a', workflow: 'beat', everyMs: 1_000 },
  { key: 'b', workflow: ReportWorkflow, input: { region: 'us' }, everyMs: 1_000 },
];

// An annotated schedule still goes in the plain list the module and `runSchedules` take.
export const _annotatedFitsTheList: ScheduledWorkflow[] = [_classTypesInput, _nameTakesAnyInput];
