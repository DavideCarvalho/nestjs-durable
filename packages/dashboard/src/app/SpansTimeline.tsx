import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { durableClient } from '../client/durable-client';
import { childRunIdOf } from './child-link';
import { ChildIcon, iconFor } from './icons';

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

type SubStatus = 'ok' | 'failed' | 'skipped';
const SUB_BAR: Record<SubStatus, string> = {
  ok: 'bg-emerald-500/40 ring-1 ring-emerald-500/50',
  failed: 'bg-red-500/40 ring-1 ring-red-500/50',
  skipped: 'bg-amber-500/35 ring-1 ring-amber-500/45',
};
const SUB_DOT: Record<SubStatus, string> = {
  ok: 'bg-emerald-400',
  failed: 'bg-red-400',
  skipped: 'bg-amber-400',
};

function RunSpans({
  run,
  timeline,
  depth,
  selected,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  depth: number;
  selected?: number;
  onSelect: (seq: number) => void;
  onOpenRun: (id: string) => void;
  expanded: Set<string>;
  onToggleChild: (childRunId: string) => void;
}) {
  const { span, rows } = useMemo(() => {
    const starts = timeline.map((s) => new Date(s.startedAt).getTime());
    const ends = timeline.map((s) => new Date(s.finishedAt).getTime());
    const t0 = Math.min(new Date(run.createdAt).getTime(), ...starts);
    const live = run.status === 'running' || run.status === 'suspended';
    const tEnd = Math.max(...ends, live ? Date.now() : t0 + 1);
    const span = Math.max(tEnd - t0, 1);
    // In a durable workflow the time lives in the WAIT between checkpoints (a step itself — a
    // dispatch, a received signal — is ~0ms). So each bar spans from the previous checkpoint to
    // this one: that's the wall-clock spent reaching it (e.g. dispatch→signal = the phase wait).
    let prev = t0;
    const rows = timeline.map((s) => {
      const end = new Date(s.finishedAt).getTime();
      const start = prev;
      prev = end;
      // Sub-process spans: each sub-process event carries its completion `at`. Render consecutive
      // bars across the step's own [startedAt, finishedAt] window, so a step that fans out into
      // sub-processes (e.g. parallel p-processes) reads as a mini-waterfall, not one opaque bar.
      const stepStart = new Date(s.startedAt).getTime();
      let subPrev = stepStart;
      const subRows = (s.events ?? [])
        .filter((e) => e.status)
        .sort((a, b) => a.at - b.at)
        .map((e, i) => {
          const at = Math.min(Math.max(e.at, stepStart), end);
          const sStart = subPrev;
          subPrev = at;
          return {
            key: `${e.name ?? 'sub'}-${e.at}-${i}`,
            name: e.name ?? 'sub-process',
            status: e.status as SubStatus,
            left: ((sStart - t0) / span) * 100,
            width: Math.max(((at - sStart) / span) * 100, 0.8),
            ms: at - sStart,
          };
        });
      return {
        step: s,
        left: ((start - t0) / span) * 100,
        width: Math.max(((end - start) / span) * 100, 0.8),
        ms: end - start,
        subRows,
      };
    });
    return { span, rows };
  }, [run, timeline]);

  return (
    <>
      {rows.map(({ step, left, width, ms, subRows }) => {
        const failed = step.status === 'failed';
        const childRunId = childRunIdOf(step);
        const isChild = !!childRunId;
        const Icon = isChild ? ChildIcon : iconFor(step.kind);
        const active = selected === step.seq;
        const isExpanded = isChild && childRunId !== undefined && expanded.has(childRunId);
        return (
          <div key={step.seq}>
            <button
              type="button"
              onClick={() => (childRunId ? onOpenRun(childRunId) : onSelect(step.seq))}
              title={isChild ? 'Child workflow — click to open its run' : undefined}
              className={`group grid w-full grid-cols-[150px_1fr] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors ${
                active ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/60'
              }`}
            >
              <span className="flex items-center gap-1.5 truncate">
                {isChild && childRunId !== undefined && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleChild(childRunId);
                    }}
                    className="shrink-0 text-indigo-400 hover:text-indigo-200 transition-colors"
                    title={isExpanded ? 'Collapse child run' : 'Expand child run inline'}
                  >
                    <span
                      className="inline-block transition-transform"
                      style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                    >
                      ▸
                    </span>
                  </button>
                )}
                <span
                  className={
                    failed ? 'text-red-400' : isChild ? 'text-indigo-300' : 'text-emerald-400'
                  }
                >
                  <Icon width={12} height={12} />
                </span>
                <span className="truncate text-[12px] text-zinc-300">{step.name}</span>
                {isChild && <span className="text-indigo-300">↗</span>}
              </span>
              <span className="relative h-5">
                {/* track */}
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--line-soft)]" />
                <span
                  className={`absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center rounded-[3px] ${
                    failed
                      ? 'bg-red-500/35 ring-1 ring-red-500/50'
                      : active
                        ? 'bg-emerald-400/45 ring-1 ring-emerald-400/60'
                        : 'bg-emerald-500/30 ring-1 ring-emerald-500/40'
                  }`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
                <span
                  className="mono tnum absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-[10px] text-zinc-500"
                  style={{ left: `min(${left + width}%, calc(100% - 44px))` }}
                >
                  {fmtDur(ms)}
                </span>
              </span>
            </button>
            {subRows.length > 0 && (
              <div className="ml-[18px] mt-0.5 mb-1 space-y-0.5 border-l border-[var(--line-soft)] pl-2">
                {subRows.map((sub) => (
                  <div
                    key={sub.key}
                    className="grid grid-cols-[130px_1fr] items-center gap-3 px-2"
                    title={`${sub.name} — ${sub.status}`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${SUB_DOT[sub.status]}`}
                      />
                      <span className="truncate text-[10px] text-zinc-400">{sub.name}</span>
                    </span>
                    <span className="relative h-3">
                      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--line-soft)]" />
                      <span
                        className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px] ${SUB_BAR[sub.status]}`}
                        style={{ left: `${sub.left}%`, width: `${sub.width}%` }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {isChild && childRunId !== undefined && isExpanded && (
              <div className="ml-[18px] mt-0.5 mb-1 border-l border-[var(--line-soft)] pl-2">
                <ChildSpans
                  id={childRunId}
                  depth={depth + 1}
                  selected={selected}
                  onSelect={onSelect}
                  onOpenRun={onOpenRun}
                  expanded={expanded}
                  onToggleChild={onToggleChild}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function ChildSpans({
  id,
  depth,
  selected,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  id: string;
  depth: number;
  selected?: number;
  onSelect: (seq: number) => void;
  onOpenRun: (id: string) => void;
  expanded: Set<string>;
  onToggleChild: (childRunId: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['run', id],
    queryFn: () => durableClient.run(id),
  });
  if (depth > 6) return null; // safety cap against pathological nesting
  if (!data)
    return <div className="mono px-2 py-1 text-[10px] text-zinc-600">loading child run…</div>;
  return (
    <div className="my-1 rounded-md border border-[var(--line)] bg-black/15">
      <div className="mono flex items-center gap-2 px-2 py-1 text-[10px] text-zinc-500">
        <span className="text-indigo-300">⌁ {data.run.workflow}</span>
        <span className="tnum text-zinc-600">{id.slice(0, 8)}</span>
        <span className={`s-${data.run.status} uppercase`}>{data.run.status}</span>
        <button
          type="button"
          onClick={() => onOpenRun(id)}
          className="ml-auto rounded border border-[var(--line)] px-1.5 text-zinc-400 hover:text-zinc-200"
        >
          open ↗
        </button>
      </div>
      <RunSpans
        run={data.run}
        timeline={data.timeline}
        depth={depth}
        selected={selected}
        onSelect={onSelect}
        onOpenRun={onOpenRun}
        expanded={expanded}
        onToggleChild={onToggleChild}
      />
    </div>
  );
}

/**
 * A span waterfall (gantt) for the run: each checkpoint is a bar placed by its start offset and
 * sized by its real duration, so you read at a glance which step took the time. Click to inspect.
 */
export function SpansTimeline({
  run,
  timeline,
  selected,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  selected?: number;
  onSelect: (seq: number) => void;
  /** Navigate to another run — used when a child-workflow row is clicked. */
  onOpenRun: (id: string) => void;
  /** Set of child run ids currently expanded inline. */
  expanded?: Set<string>;
  /** Toggle inline expansion of a child run. */
  onToggleChild?: (id: string) => void;
}) {
  // Compute span total for the top-level run header.
  const span = useMemo(() => {
    const starts = timeline.map((s) => new Date(s.startedAt).getTime());
    const ends = timeline.map((s) => new Date(s.finishedAt).getTime());
    const t0 = Math.min(new Date(run.createdAt).getTime(), ...starts);
    const live = run.status === 'running' || run.status === 'suspended';
    const tEnd = Math.max(...ends, live ? Date.now() : t0 + 1);
    return Math.max(tEnd - t0, 1);
  }, [run, timeline]);

  const resolvedExpanded = expanded ?? new Set<string>();
  const resolvedToggle = onToggleChild ?? (() => {});

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">spans</span>
        <span className="mono tnum text-[10px] text-zinc-600">total {fmtDur(span)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 pb-3">
        <RunSpans
          run={run}
          timeline={timeline}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          onOpenRun={onOpenRun}
          expanded={resolvedExpanded}
          onToggleChild={resolvedToggle}
        />
      </div>
    </div>
  );
}
