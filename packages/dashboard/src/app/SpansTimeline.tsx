import { useMemo } from 'react';
import type { StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { iconFor } from './icons';

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
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
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  selected?: number;
  onSelect: (seq: number) => void;
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
      return {
        step: s,
        left: ((start - t0) / span) * 100,
        width: Math.max(((end - start) / span) * 100, 0.8),
        ms: end - start,
      };
    });
    return { span, rows };
  }, [run, timeline]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">spans</span>
        <span className="mono tnum text-[10px] text-zinc-600">total {fmtDur(span)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 pb-3">
        {rows.map(({ step, left, width, ms }) => {
          const failed = step.status === 'failed';
          const Icon = iconFor(step.kind);
          const active = selected === step.seq;
          return (
            <button
              type="button"
              key={step.seq}
              onClick={() => onSelect(step.seq)}
              className={`group grid w-full grid-cols-[150px_1fr] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors ${
                active ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/60'
              }`}
            >
              <span className="flex items-center gap-1.5 truncate">
                <span className={failed ? 'text-red-400' : 'text-emerald-400'}>
                  <Icon width={12} height={12} />
                </span>
                <span className="truncate text-[12px] text-zinc-300">{step.name}</span>
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
          );
        })}
      </div>
    </div>
  );
}
