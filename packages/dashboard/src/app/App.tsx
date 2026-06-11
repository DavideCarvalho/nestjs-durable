import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type RunStatus,
  type StepCheckpoint,
  type WorkflowRun,
  durableClient,
} from '../client/durable-client';
import { WorkflowGraph } from './WorkflowGraph';

const STATUSES: RunStatus[] = ['running', 'suspended', 'completed', 'failed', 'cancelled'];

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function durMs(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function StatusDot({ status }: { status: RunStatus | StepCheckpoint['status'] }) {
  const live = status === 'running';
  return <span className={`dot s-${status} ${live ? 'pulse' : ''}`} aria-hidden />;
}

function Badge({ status }: { status: RunStatus | StepCheckpoint['status'] }) {
  return (
    <span
      className={`s-${status} inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider`}
    >
      <StatusDot status={status} />
      {status}
    </span>
  );
}

function Header({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<string, number>;
  filter: RunStatus | 'all';
  onFilter: (f: RunStatus | 'all') => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (key: RunStatus | 'all', label: string, n: number) => (
    <button
      key={key}
      type="button"
      onClick={() => onFilter(key)}
      className={`group flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors ${
        filter === key
          ? 'border-zinc-600 bg-zinc-900 text-zinc-100'
          : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {key !== 'all' && <StatusDot status={key} />}
      <span className="uppercase tracking-wide">{label}</span>
      <span className="mono tnum text-zinc-600">{n}</span>
    </button>
  );
  return (
    <header className="z-10 flex items-center gap-4 border-b border-[var(--line)] px-5 py-3">
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 place-items-center rounded-md border border-emerald-500/30 bg-emerald-500/10">
          <span className="text-emerald-400" aria-hidden>
            ◆
          </span>
        </div>
        <div className="leading-none">
          <div className="text-sm font-semibold tracking-tight">durable</div>
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            control plane
          </div>
        </div>
      </div>
      <div className="ml-2 flex flex-wrap items-center gap-1">
        {chip('all', 'all', total)}
        {STATUSES.map((s) => chip(s, s, counts[s] ?? 0))}
      </div>
      <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
        <span className="dot s-completed pulse" aria-hidden />
        live
      </div>
    </header>
  );
}

function RunsList({
  runs,
  selected,
  onSelect,
}: {
  runs: WorkflowRun[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) {
    return <div className="p-6 text-sm text-zinc-600">No runs yet.</div>;
  }
  return (
    <ul className="divide-y divide-[var(--line-soft)]">
      {runs.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
              selected === r.id ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-200">{r.workflow}</span>
              <Badge status={r.status} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="mono truncate text-[11px] text-zinc-600">{r.id}</span>
              <span className="shrink-0 text-[11px] text-zinc-600">{relTime(r.updatedAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RunDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['run', id], queryFn: () => durableClient.run(id) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['run', id] });
    qc.invalidateQueries({ queryKey: ['runs'] });
  };
  const retry = useMutation({ mutationFn: () => durableClient.retry(id), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => durableClient.cancel(id), onSuccess: invalidate });

  if (!data) return <div className="p-8 text-sm text-zinc-600">Loading run…</div>;
  const { run, timeline } = data;
  const canRetry = run.status === 'failed' || run.status === 'suspended';
  const canCancel = run.status === 'running' || run.status === 'suspended';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-7 py-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{run.workflow}</h2>
            <Badge status={run.status} />
            <span className="mono rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-zinc-500">
              v{run.workflowVersion}
            </span>
          </div>
          <div className="mono mt-1 text-[11px] text-zinc-600">{run.id}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!canRetry || retry.isPending}
            onClick={() => retry.mutate()}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-emerald-300 transition-colors enabled:hover:bg-emerald-500/20 disabled:opacity-30"
          >
            Retry
          </button>
          <button
            type="button"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-zinc-300 transition-colors enabled:hover:bg-zinc-800 disabled:opacity-30"
          >
            Cancel
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {timeline.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-zinc-600">
            No steps recorded yet.
          </div>
        ) : (
          <WorkflowGraph run={run} timeline={timeline} fmtDuration={durMs} />
        )}
        {run.error && (
          <div className="mono absolute inset-x-6 bottom-6 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300 backdrop-blur">
            {run.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const [selected, setSelected] = useState<string>();
  const { data: runs = [] } = useQuery({ queryKey: ['runs'], queryFn: () => durableClient.runs() });

  const counts = runs.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const shown = filter === 'all' ? runs : runs.filter((r) => r.status === filter);

  return (
    <>
      <div className="app-bg" />
      <div className="relative z-10 flex h-full flex-col">
        <Header counts={counts} filter={filter} onFilter={setFilter} />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,360px)_1fr]">
          <aside className="min-h-0 overflow-auto border-r border-[var(--line)]">
            <RunsList runs={shown} selected={selected} onSelect={setSelected} />
          </aside>
          <main className="min-h-0">
            {selected ? (
              <RunDetail id={selected} />
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <div className="text-4xl text-zinc-800" aria-hidden>
                    ◆
                  </div>
                  <p className="mt-3 text-sm text-zinc-600">Select a run to see its timeline.</p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
