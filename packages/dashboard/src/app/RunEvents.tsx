import { useSyncExternalStore } from 'react';
import type { EngineEvent } from '../client/durable-client';
import type { EventTail } from '../client/event-tail';
import { workflowHash } from './WorkflowLifecycle';
import { childRunIdOf } from './child-link';
import { Badge as Chip } from './ui/badge';
import { Button } from './ui/button';

/** An event's time of day in UTC with milliseconds (`14:03:07.120`), or the raw value if unparsable. */
export function eventTime(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : new Date(ms).toISOString().slice(11, 23);
}

/** A run an event points at, and how the row names the link. */
export interface EventLink {
  label: string;
  runId: string;
}

/**
 * The runs an event links to, from the run the detail shows: the run a `run.triggered` started, the
 * child a `step.*` event of a child step names, and, on this run's own `run.started`, the run whose
 * lifecycle event started it (`sourceRunId`) and its parent (`parentRunId`).
 */
export function eventLinks(
  event: EngineEvent,
  from: { sourceRunId?: string | undefined; parentRunId?: string | undefined },
): EventLink[] {
  if (event.type === 'run.triggered') {
    return event.triggeredRunId ? [{ label: 'started', runId: event.triggeredRunId }] : [];
  }
  if (event.type.startsWith('step.') && event.name) {
    const child = childRunIdOf({ name: event.name });
    return child ? [{ label: 'child', runId: child }] : [];
  }
  if (event.type === 'run.started') {
    return [
      ...(from.sourceRunId ? [{ label: 'started by', runId: from.sourceRunId }] : []),
      ...(from.parentRunId ? [{ label: 'parent', runId: from.parentRunId }] : []),
    ];
  }
  return [];
}

function rowClass(type: EngineEvent['type']): string {
  if (type === 'run.failed' || type === 'step.failed' || type === 'run.trigger_failed') {
    return 'text-bad';
  }
  if (type === 'run.completed' || type === 'step.completed' || type === 'run.triggered') {
    return 'text-emerald-300';
  }
  return 'text-zinc-300';
}

/**
 * The run's engine events as its live stream delivers them while the page is open, newest first,
 * the last `tail.limit` (200 by default) kept in memory. A `run.triggered` / `run.trigger_failed`
 * names its subscriber (linked to its workflow page) and links the run it started or says why it did not;
 * a child step's events link the child, and the run's own `run.started` links back to the run that
 * started it. Nothing is stored, so the panel starts empty on every load.
 */
export function RunEvents({
  tail,
  sourceRunId,
  parentRunId,
  onOpenRun,
}: {
  tail: EventTail;
  sourceRunId?: string | undefined;
  parentRunId?: string | undefined;
  onOpenRun: (id: string) => void;
}) {
  const events = useSyncExternalStore(tail.subscribe, tail.snapshot, tail.snapshot);
  return (
    <section aria-label="Events" className="mt-3">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">
        Events <span className="normal-case tracking-normal text-zinc-600">(live)</span>
      </h3>
      {events.length === 0 ? (
        <p className="mt-1 text-[11px] text-zinc-600" data-testid="events-empty">
          No events yet. This shows the engine events of this run that arrive while the page is open
          (the last {tail.limit}); they are not stored.
        </p>
      ) : (
        <ol className="mt-1 flex max-h-60 flex-col gap-0.5 overflow-y-auto">
          {[...events].reverse().map(({ id, event }) => (
            <li
              key={id}
              className="flex flex-wrap items-center gap-1.5 text-[11px]"
              data-type={event.type}
            >
              <span className="mono text-zinc-600" title={event.at}>
                {eventTime(event.at)}
              </span>
              <span className={`mono ${rowClass(event.type)}`}>{event.type}</span>
              {event.name &&
                (event.type === 'run.triggered' || event.type === 'run.trigger_failed' ? (
                  <a
                    href={workflowHash(event.name)}
                    className="mono text-zinc-200 underline-offset-2 hover:underline"
                  >
                    {event.name}
                  </a>
                ) : (
                  <span className="mono text-zinc-400">{event.name}</span>
                ))}
              {event.seq != null && <Chip className="text-[10px]">#{event.seq}</Chip>}
              {eventLinks(event, { sourceRunId, parentRunId }).map((link) => (
                <span key={`${link.label}:${link.runId}`} className="flex items-center gap-1">
                  <span className="text-[10px] text-zinc-600">{link.label}</span>
                  <Button
                    variant="chip"
                    size="xs"
                    onClick={() => onOpenRun(link.runId)}
                    className="mono max-w-[24rem] truncate px-1.5 py-0"
                    title={link.runId}
                  >
                    {link.runId}
                  </Button>
                </span>
              ))}
              {event.error?.message && <span className="text-bad">{event.error.message}</span>}
              {event.reason && <span className="text-zinc-500">{event.reason}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
