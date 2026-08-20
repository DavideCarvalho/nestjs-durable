import { describe, expect, it } from 'vitest';
import { type RunsFilterIdentity, runRowKey, runsFilterKey } from './run-list-identity';

const runs = [{ id: 'run-a' }, { id: 'run-b' }, { id: 'run-c' }];

const identity = (over: Partial<RunsFilterIdentity> = {}): RunsFilterIdentity => ({
  status: 'all',
  tag: '',
  attrs: '',
  namespace: '',
  origin: 'all',
  ...over,
});

describe('runRowKey', () => {
  it('keys a row by its run id, the same thing React reconciles it by', () => {
    expect(runRowKey(runs, 0)).toBe('run-a');
    expect(runRowKey(runs, 2)).toBe('run-c');
  });

  it('follows the run when a filter or a poll moves it to another index', () => {
    // The condition the whole fix exists for: `run-c` used to sit at index 2 and now sits at 0, so
    // its measurement has to travel with it rather than stay behind at index 2.
    const reordered = [{ id: 'run-c' }, { id: 'run-a' }];
    expect(runRowKey(runs, 2)).toBe(runRowKey(reordered, 0));
    expect(runRowKey(runs, 0)).toBe(runRowKey(reordered, 1));
  });

  it('falls back to the index past the end of the loaded page', () => {
    expect(runRowKey(runs, 7)).toBe(7);
    expect(runRowKey([], 0)).toBe(0);
  });
});

describe('runsFilterKey', () => {
  it('is stable for the same filters', () => {
    expect(runsFilterKey(identity({ tag: 'ingest' }))).toBe(
      runsFilterKey(identity({ tag: 'ingest' })),
    );
  });

  it('changes when any single filter changes', () => {
    const base = runsFilterKey(identity());
    expect(runsFilterKey(identity({ status: 'failed' }))).not.toBe(base);
    expect(runsFilterKey(identity({ tag: 'ingest' }))).not.toBe(base);
    expect(runsFilterKey(identity({ attrs: 'tier:eq:pro' }))).not.toBe(base);
    expect(runsFilterKey(identity({ namespace: 'acme' }))).not.toBe(base);
    expect(runsFilterKey(identity({ origin: 'origin:backend' }))).not.toBe(base);
  });

  it('cannot have one combination of values spell another', () => {
    expect(runsFilterKey(identity({ tag: 'a', attrs: 'b' }))).not.toBe(
      runsFilterKey(identity({ tag: 'a b' })),
    );
    expect(runsFilterKey(identity({ tag: 'a"', attrs: 'b' }))).not.toBe(
      runsFilterKey(identity({ tag: 'a', attrs: '"b' })),
    );
  });
});
