// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../client/durable-client';
import { EventTail } from '../client/event-tail';
import { RunEvents, eventLinks, eventTime } from './RunEvents';

// No jest-dom in this package (see `open-console.spec.tsx`): assertions read plain DOM properties.

afterEach(cleanup);

/** A stand-in for `durableClient.streamRun`: the test emits events into whatever subscribed. */
function fakeStream() {
  const listeners = new Set<(e: EngineEvent) => void>();
  return {
    stream(onEvent: (e: EngineEvent) => void): () => void {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    emit(event: EngineEvent): void {
      act(() => {
        for (const l of listeners) l(event);
      });
    },
  };
}

const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, s)).toISOString();

function rows(): { type: string | null; text: string }[] {
  const section = screen.getByRole('region', { name: 'Events' });
  return within(section)
    .getAllByRole('listitem')
    .map((li) => ({ type: li.getAttribute('data-type'), text: li.textContent ?? '' }));
}

describe('<RunEvents>', () => {
  it('says it shows only what arrives while the page is open, until an event arrives', () => {
    const tail = new EventTail();
    const { stream, emit } = fakeStream();
    stream((e) => tail.push(e));
    render(<RunEvents tail={tail} onOpenRun={() => {}} />);

    expect(screen.getByTestId('events-empty').textContent).toContain(
      'arrive while the page is open',
    );

    emit({ type: 'run.started', runId: 'i1', workflow: 'ingest', at: at(1) });
    expect(screen.queryByTestId('events-empty')).toBeNull();
    expect(rows()).toEqual([{ type: 'run.started', text: '12:00:01.000run.started' }]);
  });

  it('renders events as they arrive, newest first, and links lifecycle and child runs', () => {
    const tail = new EventTail();
    const { stream, emit } = fakeStream();
    stream((e) => tail.push(e));
    const onOpenRun = vi.fn();
    render(
      <RunEvents tail={tail} sourceRunId="src1" parentRunId="parent1" onOpenRun={onOpenRun} />,
    );

    emit({ type: 'run.started', runId: 'evt:src1:completed:ingest', at: at(1) });
    emit({ type: 'step.started', runId: 'r', seq: 0, name: 'signal:child:r.child.0', at: at(2) });
    emit({ type: 'run.completed', runId: 'r', at: at(3) });
    emit({
      type: 'run.triggered',
      runId: 'r',
      name: 'refresh',
      triggeredRunId: 'evt:r:completed:refresh',
      at: at(4),
    });
    emit({
      type: 'run.trigger_failed',
      runId: 'r',
      name: 'strict',
      error: { message: 'bad input' },
      at: at(5),
    });

    expect(rows()).toEqual([
      { type: 'run.trigger_failed', text: '12:00:05.000run.trigger_failedstrictbad input' },
      {
        type: 'run.triggered',
        text: '12:00:04.000run.triggeredrefreshstartedevt:r:completed:refresh',
      },
      { type: 'run.completed', text: '12:00:03.000run.completed' },
      {
        type: 'step.started',
        text: '12:00:02.000step.startedsignal:child:r.child.0#0childr.child.0',
      },
      {
        type: 'run.started',
        text: '12:00:01.000run.startedstarted bysrc1parentparent1',
      },
    ]);
    expect(screen.getByRole('link', { name: 'refresh' }).getAttribute('href')).toBe(
      '#/workflow/refresh',
    );
    expect(screen.getByRole('link', { name: 'strict' }).getAttribute('href')).toBe(
      '#/workflow/strict',
    );
    fireEvent.click(screen.getByRole('button', { name: 'evt:r:completed:refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'r.child.0' }));
    fireEvent.click(screen.getByRole('button', { name: 'src1' }));
    fireEvent.click(screen.getByRole('button', { name: 'parent1' }));
    expect(onOpenRun.mock.calls).toEqual([
      ['evt:r:completed:refresh'],
      ['r.child.0'],
      ['src1'],
      ['parent1'],
    ]);
  });

  it('keeps only the last N events', () => {
    const tail = new EventTail(3);
    const { stream, emit } = fakeStream();
    stream((e) => tail.push(e));
    render(<RunEvents tail={tail} onOpenRun={() => {}} />);

    for (let i = 0; i < 5; i += 1) {
      emit({ type: 'step.completed', runId: 'r', seq: i, name: `s${i}`, at: at(i) });
    }

    expect(rows().map((r) => r.text)).toEqual([
      '12:00:04.000step.completeds4#4',
      '12:00:03.000step.completeds3#3',
      '12:00:02.000step.completeds2#2',
    ]);
  });
});

describe('eventLinks / eventTime', () => {
  it('links nothing for an event that names no other run', () => {
    expect(eventLinks({ type: 'run.started', runId: 'r', at: at(0) }, {})).toEqual([]);
    expect(
      eventLinks({ type: 'run.triggered', runId: 'r', name: 'digest', at: at(0) }, {}),
    ).toEqual([]);
    expect(
      eventLinks({ type: 'step.completed', runId: 'r', seq: 1, name: 'load', at: at(0) }, {}),
    ).toEqual([]);
    expect(
      eventLinks({ type: 'step.completed', runId: 'r', seq: 1, name: 'spawn:c1', at: at(0) }, {}),
    ).toEqual([{ label: 'child', runId: 'c1' }]);
  });

  it('prints the UTC time of day, or the raw value', () => {
    expect(eventTime('2026-11-04T09:08:07.006Z')).toBe('09:08:07.006');
    expect(eventTime('soon')).toBe('soon');
  });
});
