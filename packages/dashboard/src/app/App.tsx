import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  type RunDetail,
  type RunDisplayStatus,
  type RunStatus,
  type StepCheckpoint,
  type WorkflowRun,
  durableClient,
  runDisplayStatus,
} from '../client/durable-client';
import { mergeLiveEvents } from '../client/merge-live-events';
import { RunInfoPanel } from './RunInfoPanel';
import { SpansTimeline } from './SpansTimeline';
import { StepDetailPanel } from './StepDetailPanel';
import { WorkflowGraph } from './WorkflowGraph';
import { PlayIcon, RetryIcon, XIcon } from './icons';

/** The durable brand mark — a workflow glyph: a rounded diamond with three connected nodes (a step
 *  flowing into the next), in currentColor so it inherits the emerald accent. Replaces the bare `◆`. */
function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="durable"
    >
      <title>durable</title>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" opacity={0.35} />
      <circle cx="6.4" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="17.6" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8.1 12h2.2M13.7 12h2.2" />
    </svg>
  );
}

const STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'dead',
];

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

function StatusDot({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  const live = status === 'running' || status === 'awaiting';
  return <span className={`dot s-${status} ${live ? 'pulse' : ''}`} aria-hidden />;
}

function Badge({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
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
          <LogoMark className="h-4 w-4 text-emerald-400" />
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
      <WorkersHealth />
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="dot s-completed pulse" aria-hidden />
        live
      </div>
    </header>
  );
}

/**
 * Per-group worker health, one chip per group: the live-worker count, turning RED when work is
 * queued but no worker is alive to drain it (`depth > 0 && liveWorkers === 0` — the "alive but not
 * consuming" failure). Polls `/workers`; renders nothing when the transport can't report health.
 */
function WorkersHealth() {
  const { data } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 10_000,
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1.5">
      {data.map((g) => {
        const live = g.liveWorkers.length;
        const starved = g.depth > 0 && live === 0;
        return (
          <span
            key={g.group}
            title={`${g.group}: ${live} live worker(s), ${g.depth} queued${starved ? ' — NO worker consuming' : ''}`}
            className={`mono flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
              starved
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                : 'border-[var(--line)] bg-zinc-800/40 text-zinc-400'
            }`}
          >
            <span
              className={`dot ${starved ? 's-failed' : live > 0 ? 's-completed' : ''}`}
              aria-hidden
            />
            {g.group}
            <span className="tnum text-zinc-500">
              {live}w{g.depth > 0 ? ` ${g.depth}q` : ''}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function RunsList({
  runs,
  selected,
  onSelect,
  onSelectTag,
}: {
  runs: WorkflowRun[];
  selected?: string | undefined;
  onSelect: (id?: string) => void;
  onSelectTag: (tag: string) => void;
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
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-zinc-200">{r.workflow}</span>
                {r.id.startsWith('dlq:') && (
                  <span className="mono shrink-0 rounded border border-rose-500/40 bg-rose-500/10 px-1 text-[9px] uppercase tracking-wider text-rose-300">
                    dlq
                  </span>
                )}
              </span>
              <Badge status={runDisplayStatus(r)} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="mono truncate text-[11px] text-zinc-600">{r.id}</span>
              <span className="shrink-0 text-[11px] text-zinc-600">{relTime(r.updatedAt)}</span>
            </div>
            {r.tags && r.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {r.tags.map((t) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: span keeps the row clickable; tag click filters
                  <span
                    key={t}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTag(t);
                    }}
                    className="mono cursor-pointer rounded border border-[var(--line)] bg-zinc-800/40 px-1.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RunDetail({ id, onOpenRun }: { id: string; onOpenRun: (id: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['run', id],
    // Merge over the cache instead of replacing it: the store only persists a step's `events` at
    // completion, so a refetch returns a still-running step empty — replacing would wipe the trail
    // the live stream appended (sub-processes flicker). Read prev AFTER the fetch so events that
    // streamed in during the request are kept too.
    queryFn: async () =>
      mergeLiveEvents(qc.getQueryData<RunDetail>(['run', id]), await durableClient.run(id)),
    // Live-follow an in-flight run; stop polling once it reaches a terminal state.
    refetchInterval: (q) => {
      const s = (q.state.data as RunDetail | undefined)?.run.status;
      return s === 'running' || s === 'suspended' ? 1500 : false;
    },
  });
  // Dead-letter link: a `dead` run may have been routed to a `dlq:<id>` handler workflow. Probe for
  // it (retry off so a 404 just hides the link) so we never render a dead link.
  const handlerId =
    (data as RunDetail | undefined)?.run.status === 'dead' ? `dlq:${id}` : undefined;
  const { data: dlqHandler } = useQuery({
    queryKey: ['run', handlerId],
    queryFn: () => durableClient.run(handlerId as string),
    enabled: !!handlerId,
    retry: false,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['run', id] });
    qc.invalidateQueries({ queryKey: ['runs'] });
  };
  // Live-tail over SSE: refresh the moment an event lands instead of waiting for the poll. Only
  // while the run is in flight; the 1.5s poll above stays as a fallback (e.g. transport with no
  // control plane, or a dropped stream).
  const liveStatus = (data as RunDetail | undefined)?.run.status;
  const isLive = liveStatus === 'running' || liveStatus === 'suspended';
  useEffect(() => {
    if (!isLive) return;
    return durableClient.streamRun(id, (event) => {
      // `step.progress` carries a single live event from a still-running step — merge it straight
      // into the cached step's `events` so a long step's trail streams in line-by-line. Invalidating
      // per event would mean a store refetch per log line (hundreds for a fan-out step) AND would
      // show nothing until the step completes, since the store only gets `events` at completion.
      if (event.type === 'step.progress' && event.event && event.seq != null) {
        const seq = event.seq;
        const live = event.event;
        qc.setQueryData(['run', id], (prev: RunDetail | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            timeline: prev.timeline.map((step) =>
              step.seq === seq ? { ...step, events: [...(step.events ?? []), live] } : step,
            ),
          };
        });
        return;
      }
      // Lifecycle events (step started/completed, run settled) change authoritative state — refetch.
      qc.invalidateQueries({ queryKey: ['run', id] });
    });
  }, [id, isLive, qc]);
  const retry = useMutation({ mutationFn: () => durableClient.retry(id), onSuccess: invalidate });
  const cancel = useMutation({
    mutationFn: (compensate?: boolean) =>
      durableClient.cancel(id, compensate !== undefined ? { compensate } : {}),
    onSuccess: invalidate,
  });
  const cont = useMutation({ mutationFn: () => durableClient.continue(id), onSuccess: invalidate });
  // Fix-and-replay: edit the input as JSON, then re-run as a fresh linked run.
  const fixReplay = useMutation({
    mutationFn: (input: unknown) => durableClient.retryWithInput(id, input),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      onOpenRun(r.runId);
    },
  });
  const onFixReplay = () => {
    const current = JSON.stringify((data as RunDetail | undefined)?.run.input ?? {}, null, 2);
    const edited = window.prompt('Fix the input, then replay as a fresh run:', current);
    if (edited == null) return;
    try {
      fixReplay.mutate(JSON.parse(edited));
    } catch {
      window.alert('Invalid JSON');
    }
  };
  // The selected step + the run it belongs to (a nested child step belongs to its child run, not the
  // root) — so the detail panel renders any lane's step, not just the root timeline's.
  const [selStep, setSelStep] = useState<{ step: StepCheckpoint; run: WorkflowRun }>();
  const [showRunIO, setShowRunIO] = useState(false);
  const [expandedChildren, setExpandedChildren] = useState<Set<string>>(new Set());
  // User-resizable height (px) of the spans panel; drag the divider above it. Clamped so neither the
  // graph nor the spans can be squeezed to nothing.
  const [spanHeight, setSpanHeight] = useState(240);
  function onResizeSpans(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setSpanHeight((h) => Math.max(120, Math.min(720, h - ev.movementY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function toggleChild(childId: string) {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) {
        next.delete(childId);
      } else {
        next.add(childId);
      }
      return next;
    });
  }

  if (!data) return <div className="p-8 text-sm text-zinc-600">Loading run…</div>;
  const { run, timeline } = data;
  // A dead-letter run is a recovery path, not the normal flow — surface it as a banner. The two ends
  // of the relationship, linked both ways:
  //  - a `dlq:<id>` run is a handler → link back to the dead run it's handling
  //  - a `dead` run with an existing `dlq:<id>` handler → link forward to it
  const isDlqHandler = run.id.startsWith('dlq:');
  const dlqLink = isDlqHandler
    ? {
        id: run.id.slice(4),
        title: 'Dead-letter handler',
        subtitle: `started because run ${run.id.slice(4)} was dead-lettered`,
        cta: 'open dead run →',
      }
    : dlqHandler
      ? {
          id: `dlq:${run.id}`,
          title: 'Dead-lettered',
          subtitle: 'this run exceeded recovery and was routed to a DLQ handler',
          cta: 'open DLQ handler →',
        }
      : undefined;
  const canRetry = run.status === 'failed' || run.status === 'suspended';
  const canCancel = run.status === 'running' || run.status === 'suspended';
  // Paused at a breakpoint = a pending `signal` checkpoint named `breakpoint:*` (see ctx.breakpoint).
  const atBreakpoint = timeline.some(
    (s) => s.status === 'pending' && s.kind === 'signal' && s.name.startsWith('breakpoint'),
  );
  // Stable key identifying the selected step across lanes (root + nested children).
  const selKey = selStep ? `${selStep.step.runId}#${selStep.step.seq}` : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-7 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{run.workflow}</h2>
            {isDlqHandler && (
              <span className="mono rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">
                dlq
              </span>
            )}
            <Badge status={runDisplayStatus(run, timeline)} />
            <span className="mono rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-zinc-500">
              v{run.workflowVersion}
            </span>
            <span className="mono tnum text-[11px] text-zinc-600">
              {timeline.length} {timeline.length === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="mono mt-1 truncate text-[11px] text-zinc-600">{run.id}</div>
          {run.tags && run.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {run.tags.map((t) => (
                <span
                  key={t}
                  className="mono rounded border border-[var(--line)] bg-zinc-800/40 px-1.5 text-[10px] text-zinc-400"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
          {run.searchAttributes && Object.keys(run.searchAttributes).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(run.searchAttributes).map(([k, v]) => (
                <span
                  key={k}
                  className="mono rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300"
                  title="search attribute"
                >
                  {k}={String(v)}
                </span>
              ))}
            </div>
          )}
          {(data as RunDetail | undefined)?.children?.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-zinc-600">children:</span>
              {(data as RunDetail).children?.map((cid) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: span keeps the row layout; click navigates
                <span
                  key={cid}
                  onClick={() => onOpenRun(cid)}
                  className="mono cursor-pointer rounded border border-[var(--line)] bg-zinc-800/40 px-1.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  {cid}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setShowRunIO(true)}
            className="mono rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            title="Run input / output"
          >
            {'{ }'}
          </button>
          {atBreakpoint && (
            <button
              type="button"
              disabled={cont.isPending}
              onClick={() => cont.mutate()}
              className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-amber-200 transition-colors enabled:hover:bg-amber-500/25 disabled:opacity-30"
            >
              <PlayIcon width={12} height={12} />
              Continue
            </button>
          )}
          <button
            type="button"
            disabled={!canRetry || retry.isPending}
            onClick={() => retry.mutate()}
            className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-emerald-300 transition-colors enabled:hover:bg-emerald-500/20 disabled:opacity-30"
          >
            <RetryIcon width={12} height={12} />
            Retry
          </button>
          {(run.status === 'dead' || run.status === 'failed') && (
            <button
              type="button"
              disabled={fixReplay.isPending}
              onClick={onFixReplay}
              title="Edit the input and re-run as a fresh linked run"
              className="flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-indigo-300 transition-colors enabled:hover:bg-indigo-500/20 disabled:opacity-30"
            >
              <RetryIcon width={12} height={12} />
              Fix &amp; replay
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(true)}
              title="Cancel and run saga compensations (undo completed steps in reverse)"
              className="flex items-center gap-1.5 rounded-md border border-amber-600/30 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-amber-300/90 transition-colors enabled:hover:bg-amber-900/20 disabled:opacity-30"
            >
              <RetryIcon width={12} height={12} />
              Cancel + Undo
            </button>
          )}
          <button
            type="button"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate(false)}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-zinc-300 transition-colors enabled:hover:bg-zinc-800 disabled:opacity-30"
          >
            <XIcon width={12} height={12} />
            Cancel
          </button>
        </div>
      </div>
      {dlqLink && (
        <div className="flex items-center gap-3 border-b border-rose-500/30 bg-rose-500/10 px-7 py-3">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-rose-500/40 bg-rose-500/15 text-sm text-rose-300"
            aria-hidden
          >
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-rose-200">{dlqLink.title}</div>
            <div className="mono truncate text-[11px] text-rose-300/70">{dlqLink.subtitle}</div>
          </div>
          <button
            type="button"
            onClick={() => onOpenRun(dlqLink.id)}
            className="mono shrink-0 rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-[11px] text-rose-200 transition-colors hover:bg-rose-500/25"
          >
            {dlqLink.cta}
          </button>
        </div>
      )}
      <div
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateRows: timeline.length > 0 ? `1fr ${spanHeight}px` : '1fr' }}
      >
        <div className="relative min-h-0">
          {timeline.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-zinc-600">
              No steps recorded yet.
            </div>
          ) : (
            <WorkflowGraph
              run={run}
              timeline={timeline}
              selectedKey={selKey}
              onSelect={(step, stepRun) => setSelStep({ step, run: stepRun })}
              onOpenRun={onOpenRun}
              fmtDuration={durMs}
              expanded={expandedChildren}
              onToggleChild={toggleChild}
            />
          )}
          {(run.status === 'failed' || run.status === 'cancelled') && run.error && (
            <div className="mono absolute inset-x-6 bottom-6 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300 backdrop-blur">
              {run.error.message}
            </div>
          )}
        </div>
        {timeline.length > 0 && (
          // The spans height lives in the GRID TRACK above (`clamp(...)`), not here — an `auto` track
          // sizes to the tall span content's min-content and collapses the `1fr` WorkflowGraph row to
          // 0. With the track clamped, this wrapper just fills it and clips; SpansTimeline scrolls.
          <div className="relative min-h-0 overflow-hidden border-t border-[var(--line)] bg-black/20">
            {/* Drag the top edge to resize the spans panel. */}
            <div
              onPointerDown={onResizeSpans}
              className="absolute inset-x-0 top-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-emerald-500/40"
              title="Drag to resize"
            />
            <SpansTimeline
              run={run}
              timeline={timeline}
              selectedKey={selKey}
              onSelect={(step, stepRun) => setSelStep({ step, run: stepRun })}
              onOpenRun={onOpenRun}
              expanded={expandedChildren}
              onToggleChild={toggleChild}
            />
          </div>
        )}
        {selStep && (
          <StepDetailPanel
            step={selStep.step}
            run={selStep.run}
            onClose={() => setSelStep(undefined)}
            onOpenRun={onOpenRun}
          />
        )}
        {showRunIO && <RunInfoPanel run={run} onClose={() => setShowRunIO(false)} />}
      </div>
    </div>
  );
}

/** The open run id encoded in the URL hash (`#/run/<id>`) — so a run is deep-linkable / shareable. */
function runIdFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.hash.match(/^#\/run\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function App() {
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [attrFilter, setAttrFilter] = useState('');
  // The open run lives in the URL hash so it survives reload and can be shared/linked.
  const [selected, setSelectedState] = useState<string | undefined>(() => runIdFromHash());
  const setSelected = useCallback((id?: string) => {
    setSelectedState(id);
    if (typeof window === 'undefined') return;
    const hash = id ? `#/run/${encodeURIComponent(id)}` : '';
    const url = hash || window.location.pathname + window.location.search;
    if (window.location.hash !== hash) window.history.pushState(null, '', url);
  }, []);
  // Follow back/forward and external hash edits.
  useEffect(() => {
    const sync = () => setSelectedState(runIdFromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const qc = useQueryClient();
  // Comma-separated `key:op:value` predicates (e.g. `amount:gte:200, tier:eq:pro`), ANDed server-side.
  const attrPredicates = attrFilter
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const { data: runs = [] } = useQuery({
    queryKey: ['runs', tagFilter, attrPredicates.join('|')],
    queryFn: () =>
      durableClient.runs(
        undefined,
        tagFilter || undefined,
        attrPredicates.length ? attrPredicates : undefined,
      ),
    refetchInterval: 3000, // keep the run list live
  });
  const bulk = useMutation({
    mutationFn: (action: 'retry' | 'cancel') =>
      durableClient.bulk(action, {
        status: filter !== 'all' ? filter : undefined,
        tag: tagFilter || undefined,
        attr: attrPredicates.length ? attrPredicates : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });

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
          <aside className="flex min-h-0 flex-col border-r border-[var(--line)]">
            <div className="border-b border-[var(--line)] p-2">
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2">
                <span className="text-zinc-600">#</span>
                <input
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  placeholder="filter by tag…"
                  className="mono w-full bg-transparent py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                />
                {tagFilter && (
                  <button
                    type="button"
                    onClick={() => setTagFilter('')}
                    className="text-zinc-600 hover:text-zinc-300"
                    title="clear tag filter"
                  >
                    <XIcon width={12} height={12} />
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2">
                <span className="text-zinc-600">⛃</span>
                <input
                  value={attrFilter}
                  onChange={(e) => setAttrFilter(e.target.value)}
                  placeholder="attrs e.g. amount:gte:200, tier:eq:pro"
                  title="Typed search attributes: comma-separated key:op:value (ops eq ne gt gte lt lte)"
                  className="mono w-full bg-transparent py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                />
                {attrFilter && (
                  <button
                    type="button"
                    onClick={() => setAttrFilter('')}
                    className="text-zinc-600 hover:text-zinc-300"
                    title="clear attribute filter"
                  >
                    <XIcon width={12} height={12} />
                  </button>
                )}
              </div>
            </div>
            {(filter !== 'all' || tagFilter || attrPredicates.length > 0) && shown.length > 0 && (
              <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
                <span className="mono text-[10px] text-zinc-500">
                  {shown.length} {filter !== 'all' ? filter : ''} {tagFilter && `#${tagFilter}`}
                  {attrPredicates.length > 0 && ` ⛃${attrPredicates.length}`}
                </span>
                <button
                  type="button"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate('retry')}
                  className="mono ml-auto rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  retry all
                </button>
                <button
                  type="button"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate('cancel')}
                  className="mono rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                >
                  cancel all
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              <RunsList
                runs={shown}
                selected={selected}
                onSelect={setSelected}
                onSelectTag={setTagFilter}
              />
            </div>
          </aside>
          <main className="min-h-0">
            {selected ? (
              <RunDetail key={selected} id={selected} onOpenRun={setSelected} />
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div className="flex flex-col items-center">
                  <LogoMark className="h-10 w-10 text-zinc-800" />
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
