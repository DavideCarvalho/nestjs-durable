import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GroupHealth,
  type RunDetail as RunDetailData,
  type RunDisplayStatus,
  type RunStatus,
  SINGLETON_INFLIGHT_STATUSES,
  type StepCheckpoint,
  type WorkerStatus,
  type WorkflowRun,
  deriveRunState,
  durableClient,
} from '../client/durable-client';
import { type PartitionView, groupByPartition } from '../client/group-by-partition';
import { mergeLiveEvents } from '../client/merge-live-events';
import { type WorkerView, pivotByWorker } from '../client/pivot-by-worker';
import { partitionOf } from '../client/queue-partition';
import {
  ALL_ORIGINS,
  type OriginFilter,
  UNKNOWN_ORIGIN,
  UNKNOWN_ORIGIN_TITLE,
  emptyRunsNotice,
  knownOrigin,
  matchesOrigin,
  originFacetsFromCounts,
  originFilterKey,
  originLabel,
  unknownCountFromFacets,
} from '../client/run-origin';
import {
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from '../client/split-compensations';
import { type HealthSummary, stalledWorkflows, summarizeHealth } from '../client/summarize-health';
import { AttributeFilters } from './AttributeFilters';
import { OriginFacets } from './OriginFacets';
import { RunInfoPanel } from './RunInfoPanel';
import { SpansTimeline } from './SpansTimeline';
import { StepDetailPanel } from './StepDetailPanel';
import { WorkflowGraph } from './WorkflowGraph';
import { BoltIcon, PlayIcon, RetryIcon, XIcon } from './icons';
import { shouldLoadMore } from './load-more';
import { parentRunIdOf, retryOriginOf } from './run-lineage';
import { runRowKey, runsFilterKey } from './run-list-identity';
import { Badge as Chip, badgeVariants } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/cn';
import { Dialog } from './ui/dialog';
import { MultiSelect, type MultiSelectOption } from './ui/multi-select';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
import { Tooltip, TooltipProvider } from './ui/tooltip';

/**
 * A value picker's options, from what the server counted. The `null` row (a run with NO value on
 * that axis) is dropped: it is a real bucket for counting, but nothing an operator can select as
 * text — the origin facet has its own "unknown" chip for exactly that reason.
 */
function selectableValues(rows: { value: string | null; count: number }[]): MultiSelectOption[] {
  return rows
    .filter((row): row is { value: string; count: number } => row.value !== null)
    .map((row) => ({ value: row.value, count: row.count }));
}

/** The durable brand mark — a workflow glyph: a rounded diamond with three connected nodes (a step
 *  flowing into the next), in currentColor so it inherits the `--accent` token. Replaces the bare `◆`. */
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
  'cancelling',
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
  const live = status === 'running' || status === 'awaiting' || status === 'cancelling';
  return <span className={`dot s-${status} ${live ? 'pulse' : ''}`} aria-hidden />;
}

function Badge({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  return (
    <Chip variant="status" className={`s-${status} text-[11px]`}>
      <StatusDot status={status} />
      {status}
    </Chip>
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
    <Button
      key={key}
      variant="ghost"
      size="chip"
      aria-pressed={filter === key}
      onClick={() => onFilter(key)}
      className={cn(
        'rounded-md',
        filter === key && 'border-zinc-600 bg-zinc-900 text-zinc-100 hover:text-zinc-100',
      )}
    >
      {key !== 'all' && <StatusDot status={key} />}
      <span className="uppercase tracking-wide">{label}</span>
      <span className="mono tnum text-zinc-600">{n}</span>
    </Button>
  );
  // Topology is fixed for a deployment's lifetime, so fetch once and never refetch.
  const { data: topology } = useQuery({
    queryKey: ['topology'],
    queryFn: () => durableClient.topology(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const isTenant = topology?.role === 'tenant';
  const roleLabel = !topology
    ? ''
    : isTenant
      ? topology.tenant
        ? `tenant · ${topology.tenant}`
        : 'tenant'
      : 'control plane';
  return (
    <header className="z-10 flex items-center gap-4 border-b border-line px-5 py-3">
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 place-items-center rounded-md border border-brand/30 bg-brand/10">
          <LogoMark className="h-4 w-4 text-brand" />
        </div>
        <div className="leading-none">
          <div className="text-sm font-semibold tracking-tight">durable</div>
          <div
            className={`mono text-[10px] uppercase tracking-[0.2em] ${
              isTenant ? 'text-amber-400/80' : 'text-zinc-600'
            }`}
            title={
              isTenant
                ? `Tenant deployment — partition ${topology?.tenant ?? '(unnamed)'}`
                : 'Control-plane deployment'
            }
          >
            {roleLabel}
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

/** Compact "Nm ago" relative stamp for an epoch-ms instant. */
function relAgoMs(atMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * One worker's live snapshot: concurrency mode + live limit, in-flight saturation, RAM/CPU%,
 * throughput, p95, and the adaptive controller's last move. A worker from an older SDK with no
 * `status` renders "no status" (a mixed fleet stays visible). Shared by the per-group `WorkerRows`
 * and the by-pod worker view.
 */
function WorkerStatusCells({ status }: { status: WorkerStatus | undefined }) {
  const c = status?.concurrency;
  if (!status || !c) {
    return <span className="mono text-[9px] text-zinc-600">no status</span>;
  }
  const saturated = c.limit > 0 && status.inFlight >= c.limit * 0.8;
  return (
    <div className="flex flex-col gap-1">
      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
        <span
          className={`shrink-0 rounded border px-1 text-[9px] uppercase tracking-wider ${
            c.mode === 'adaptive'
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
              : 'border-zinc-600/50 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          {c.mode === 'adaptive' ? `adaptive ${c.min ?? 1}–${c.max ?? 32}` : 'fixed'}
        </span>
        <span className={saturated ? 'text-amber-300' : 'text-zinc-400'}>
          in-flight{' '}
          <span className="tnum">
            {status.inFlight}/{c.limit}
          </span>
        </span>
        {typeof status.rssPct === 'number' && (
          <span className={status.rssPct >= 85 ? 'text-rose-300' : ''}>
            ram <span className="tnum">{Math.round(status.rssPct)}%</span>
          </span>
        )}
        {typeof status.cpuPct === 'number' && (
          <span>
            cpu <span className="tnum">{Math.round(status.cpuPct)}%</span>
          </span>
        )}
        {typeof status.throughputPerMin === 'number' && (
          <span>
            <span className="tnum">{Math.round(status.throughputPerMin)}</span>/min
          </span>
        )}
        {typeof status.p95Ms === 'number' && (
          <span>
            p95 <span className="tnum">{Math.round(status.p95Ms)}ms</span>
          </span>
        )}
      </div>
      {status.lastAdjust && (
        <div className="mono text-[10px] text-zinc-500">
          {status.lastAdjust.reason}{' '}
          <span className="tnum text-zinc-400">
            {status.lastAdjust.from}→{status.lastAdjust.to}
          </span>{' '}
          {relAgoMs(status.lastAdjust.at)}
        </div>
      )}
    </div>
  );
}

/** Per-worker rows for an expanded group: each live worker's id + its {@link WorkerStatusCells}. */
function WorkerRows({ workers }: { workers: GroupHealth['liveWorkers'] }) {
  return (
    <div className="flex flex-col divide-y divide-line-soft">
      {workers.map((w) => (
        <div key={w.instanceId} className="flex flex-col gap-1 px-2.5 py-2">
          <span className="mono truncate text-[10px] text-zinc-400">{w.instanceId}</span>
          <WorkerStatusCells status={w.status} />
        </div>
      ))}
    </div>
  );
}

type WorkersPanelView = 'workers' | 'partitions' | 'alerts';

/**
 * Worker health, three ways (toggle). Route-by-handler makes every `@Step`/`@Workflow` its own queue
 * and one worker serves many, so a per-queue list is noise — these views collapse it onto the axes
 * that actually vary: **workers** (each live pod + what it's serving; the default), **partitions**
 * (the tenant-isolation axis), and **alerts** (only starved queues — `depth > 0` with no worker).
 * Polls `/workers`; renders nothing when the transport can't report health.
 */
function WorkersHealth() {
  const { data } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 10_000,
  });
  const [view, setView] = useState<WorkersPanelView>('workers');
  if (!data || data.length === 0) return null;
  const summary = summarizeHealth(data);
  const label: Record<WorkersPanelView, string> = {
    workers: 'pods',
    partitions: 'parts',
    alerts: 'alerts',
  };
  return (
    <Tabs
      value={view}
      onValueChange={(v) => setView(v as WorkersPanelView)}
      className="ml-auto flex flex-nowrap items-center gap-1.5"
    >
      <TabsList>
        {(['workers', 'partitions', 'alerts'] as const).map((v) => (
          <TabsTab key={v} value={v}>
            {label[v]}
            {v === 'alerts' && summary.starved.length > 0 && (
              <span className="tnum ml-1 rounded bg-rose-500/80 px-1 text-[9px] text-white">
                {summary.starved.length}
              </span>
            )}
          </TabsTab>
        ))}
      </TabsList>
      {/* Fixed-width, right-justified slot: toggling views swaps content inside a stable box, so the
          header never reflows (no wrap to a 2nd line, no width jump). The expand popovers are
          portalled, so they are no longer at the mercy of this box's overflow. */}
      <div className="flex w-[300px] flex-nowrap items-center justify-end gap-1.5">
        <TabsPanel value="workers" className="flex flex-nowrap items-center gap-1.5">
          <WorkersByPod workers={pivotByWorker(data)} />
        </TabsPanel>
        <TabsPanel value="partitions" className="flex flex-nowrap items-center gap-1.5">
          <PartitionsHealth groups={data} />
        </TabsPanel>
        <TabsPanel value="alerts" className="flex flex-nowrap items-center gap-1.5">
          <StarvationAlerts summary={summary} />
        </TabsPanel>
      </div>
    </Tabs>
  );
}

/**
 * Default view: one chip per live worker (pod), with its partition, how many handlers it serves, and
 * its in-flight load. Clicking expands its full status ({@link WorkerStatusCells}) plus the list of
 * handlers it's subscribed to.
 */
// Sentinel `open` key for the "+N" overflow popover (can't collide with any real instanceId).
const OVERFLOW_KEY = '__overflow__';

function loadOf(w: WorkerView): string | undefined {
  const c = w.status?.concurrency;
  return w.status && c ? `${w.status.inFlight}/${c.limit}` : undefined;
}

/** The expanded body for one pod — its live status cells plus the full list of handlers it serves.
 *  Shared by the inline pod chip's popover AND the "+N" overflow popover's expandable rows, so a pod
 *  hidden behind "+N" reveals exactly the same detail as a visible chip. */
function PodDetail({ w }: { w: WorkerView }) {
  return (
    <>
      <div className="px-2.5 py-2">
        <WorkerStatusCells status={w.status} />
      </div>
      <div className="max-h-48 overflow-auto border-t border-line-soft px-2.5 py-1.5">
        <div className="mono mb-1 text-[9px] uppercase tracking-wider text-zinc-600">
          {w.handlers.length} handlers
        </div>
        {w.handlers.map((h) => (
          <div key={h} className="mono truncate text-[10px] text-zinc-400">
            {h}
          </div>
        ))}
      </div>
    </>
  );
}

function WorkersByPod({ workers }: { workers: WorkerView[] }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  // Which pod is expanded INSIDE the "+N" overflow popover (independent of the inline chips' `open`).
  const [overflowPod, setOverflowPod] = useState<string | undefined>(undefined);
  // Cap inline chips so the pod row can never overflow its fixed slot and paint over the view toggle
  // (long pod instanceIds mean even a couple of full-width chips exceed 300px). The rest collapse into
  // a clickable "+N" chip whose popover lists exactly which pods it hides.
  const MAX_INLINE = 2;
  const visible = workers.slice(0, MAX_INLINE);
  const overflow = workers.slice(MAX_INLINE);
  const overflowOpen = open === OVERFLOW_KEY;
  return (
    <>
      {visible.map((w) => {
        const isOpen = open === w.instanceId;
        const load = loadOf(w);
        return (
          <Popover
            key={w.instanceId}
            open={isOpen}
            onOpenChange={(next) => setOpen(next ? w.instanceId : undefined)}
          >
            <Tooltip
              suppressed={isOpen}
              label={`${w.instanceId}\n${w.handlers.length} handlers · ${w.partition}${load ? ` · ${load} in-flight` : ''}`}
            >
              <PopoverTrigger
                render={
                  <Button
                    variant="chip"
                    size="xs"
                    className={cn(
                      'mono max-w-[120px] gap-1',
                      isOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                    )}
                  >
                    <span className={`dot ${w.status ? 's-completed' : ''}`} aria-hidden />
                    <span className="truncate">{w.instanceId}</span>
                    {w.partition !== 'default' && (
                      <span className="shrink-0 text-zinc-500">@{w.partition}</span>
                    )}
                    <span className="tnum shrink-0 text-zinc-500">
                      {w.handlers.length}h{load ? ` · ${load}` : ''}
                    </span>
                  </Button>
                }
              />
            </Tooltip>
            <PopoverContent>
              <div className="mono flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-[10px] text-zinc-500">
                <span className="truncate text-zinc-300">{w.instanceId}</span>
                <span className="shrink-0">
                  {w.runtime ?? 'node'} · {w.partition}
                </span>
              </div>
              <PodDetail w={w} />
            </PopoverContent>
          </Popover>
        );
      })}
      {overflow.length > 0 && (
        <Popover
          open={overflowOpen}
          onOpenChange={(next) => {
            setOpen(next ? OVERFLOW_KEY : undefined);
            setOverflowPod(undefined);
          }}
        >
          <PopoverTrigger
            render={
              <Button
                variant="chip"
                size="xs"
                className={cn(
                  'mono shrink-0',
                  overflowOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                )}
              >
                +{overflow.length}
              </Button>
            }
          />
          <PopoverContent>
            <div className="mono border-b border-line px-2.5 py-1.5 text-[9px] uppercase tracking-wider text-zinc-600">
              {overflow.length} more {overflow.length === 1 ? 'pod' : 'pods'}
            </div>
            <div className="max-h-80 divide-y divide-line-soft overflow-auto">
              {overflow.map((w) => {
                const load = loadOf(w);
                const podOpen = overflowPod === w.instanceId;
                return (
                  <div key={w.instanceId}>
                    {/* Same click-to-expand as a visible chip: the row toggles the pod's PodDetail. */}
                    <button
                      type="button"
                      onClick={() => setOverflowPod(podOpen ? undefined : w.instanceId)}
                      className={cn(
                        'mono flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[10px] hover:bg-zinc-800/50',
                        podOpen ? 'bg-zinc-800/40 text-zinc-200' : 'text-zinc-300',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className={`dot ${w.status ? 's-completed' : ''}`} aria-hidden />
                        <span className="truncate">{w.instanceId}</span>
                      </span>
                      <span className="tnum shrink-0 text-zinc-500">
                        {w.partition !== 'default' ? `@${w.partition} · ` : ''}
                        {w.handlers.length}h{load ? ` · ${load}` : ''}
                      </span>
                    </button>
                    {podOpen && (
                      <div className="border-t border-line-soft bg-zinc-900/40">
                        <PodDetail w={w} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

/**
 * Partition view: one chip per tenant-isolation partition (`default` = the operator/control plane),
 * with its worker count, handler count, and total queue depth — turning RED when any queue in it is
 * starved. Clicking expands the partition's live workers ({@link WorkerRows}).
 */
function PartitionsHealth({ groups }: { groups: GroupHealth[] }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const partitions = groupByPartition(groups);
  function workersOf(partition: string): GroupHealth['liveWorkers'] {
    const seen = new Map<string, GroupHealth['liveWorkers'][number]>();
    for (const g of groups) {
      if (partitionOf(g.group) !== partition) continue;
      for (const w of g.liveWorkers) if (!seen.has(w.instanceId)) seen.set(w.instanceId, w);
    }
    return [...seen.values()];
  }
  return (
    <>
      {partitions.map((p: PartitionView) => {
        const starved = p.starvedCount > 0;
        const isOpen = open === p.partition;
        return (
          <Popover
            key={p.partition}
            open={isOpen && p.workerCount > 0}
            onOpenChange={(next) => setOpen(next ? p.partition : undefined)}
          >
            <Tooltip
              suppressed={isOpen}
              label={`${p.partition}\n${p.workerCount} workers · ${p.handlerCount} handlers · ${p.totalDepth} queued${starved ? ` · ${p.starvedCount} starved` : ''}`}
            >
              <PopoverTrigger
                render={
                  <Button
                    variant="chip"
                    size="xs"
                    disabled={p.workerCount === 0}
                    className={cn(
                      'mono gap-1',
                      starved && 'border-rose-500/50 bg-rose-500/15 text-rose-300',
                      !starved && isOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                      p.workerCount > 0 ? 'cursor-pointer' : 'cursor-default',
                    )}
                  >
                    <span
                      className={`dot ${starved ? 's-failed' : p.workerCount > 0 ? 's-completed' : ''}`}
                      aria-hidden
                    />
                    {p.partition}
                    <span className="tnum text-zinc-500">
                      {p.workerCount}w {p.handlerCount}h
                      {p.totalDepth > 0 ? ` ${p.totalDepth}q` : ''}
                      {starved ? ` ${p.starvedCount}!` : ''}
                    </span>
                  </Button>
                }
              />
            </Tooltip>
            <PopoverContent>
              <div className="mono flex items-center justify-between border-b border-line px-2.5 py-1.5 text-[10px] text-zinc-500">
                <span className="text-zinc-300">{p.partition}</span>
                <span className="tnum">
                  {p.workerCount} worker(s) · {p.totalDepth} queued
                </span>
              </div>
              <WorkerRows workers={workersOf(p.partition)} />
            </PopoverContent>
          </Popover>
        );
      })}
    </>
  );
}

/**
 * Alerts view: the panel's actual purpose distilled — a compact summary plus a red chip for EACH
 * starved queue (`depth > 0 && liveWorkers === 0`, work with no consumer). Nothing but the summary
 * when everything is draining.
 */
function StarvationAlerts({ summary }: { summary: HealthSummary }) {
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return (
    <>
      <Tooltip
        label={`Route-by-handler: each @Workflow & @Step is served as its own queue.\n${summary.queueCount} queues across ${plural(summary.workerCount, 'worker')}.`}
      >
        <span className="mono tnum text-[10px] text-zinc-500">
          {plural(summary.workflowCount, 'workflow')} · {plural(summary.stepCount, 'step')} ·{' '}
          {plural(summary.workerCount, 'worker')} ·{' '}
          {summary.allDraining ? (
            <span className="text-good">all draining</span>
          ) : (
            <span className="text-rose-300">{summary.starved.length} starved</span>
          )}
        </span>
      </Tooltip>
      {summary.starved.map((g) => (
        <Tooltip key={g.group} label={`${g.group}\n${g.depth} queued, no worker consuming`}>
          <Chip variant="danger" className="mono gap-1 border-rose-500/50 bg-rose-500/15 py-0.5">
            <span className="dot s-failed" aria-hidden />
            <span className="max-w-[180px] truncate">{g.group}</span>
            <span className="tnum shrink-0">{g.depth}q · 0w</span>
          </Chip>
        </Tooltip>
      ))}
    </>
  );
}

/** Placeholder rows shown while the first `/runs` fetch is in flight, so the pane never flashes
 *  "No runs yet." before real data lands. Same row footprint as a real run → no layout jump. */
function RunsListSkeleton() {
  return (
    <ul className="divide-y divide-line-soft" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-800" />
            <div className="h-3 w-16 animate-pulse rounded bg-zinc-800/70" />
          </div>
          <div className="h-2.5 w-48 animate-pulse rounded bg-zinc-800/50" />
        </li>
      ))}
    </ul>
  );
}

/**
 * One row of the run list. Split out and memoised because the list is LIVE: it refetches every few
 * seconds, and without this every poll re-renders every mounted row even though a poll typically
 * changes a handful. The derived state is computed here so a row that did not change does no work at
 * all — `deriveRunState` joins against worker health and the sibling set, which is not free per row.
 */
const RunRow = memo(function RunRow({
  run,
  siblings,
  health,
  selected,
  onSelect,
  onSelectTag,
  onSelectNamespace,
  onSelectOrigin,
}: {
  run: WorkflowRun;
  siblings: WorkflowRun[];
  health: GroupHealth[];
  selected: boolean;
  onSelect: (id?: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectNamespace: (namespace: string) => void;
  onSelectOrigin: (filter: OriginFilter) => void;
}) {
  const state = deriveRunState(run, { runs: siblings, health });
  // Bound as consts so the click handlers close over a narrowed value (a property read would
  // widen back to `string | undefined` inside the callback). Both chips are POINTER shortcuts
  // for the sidebar filters, exactly like the tag chips below: a nested <button> would be
  // invalid markup inside the row's own button, so the row stays the keyboard target.
  const tenant = run.namespace && run.namespace !== 'default' ? run.namespace : undefined;
  const origin = knownOrigin(run.origin);
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
        selected ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-200">{run.workflow}</span>
          {tenant && (
            <Chip
              variant="tenant"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-sky-400/60 hover:text-sky-200"
              title={`Tenant / worker-pool partition — click to show only ${tenant}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNamespace(tenant);
              }}
            >
              {tenant}
            </Chip>
          )}
          {/* Origin, when the run HAS one. An unattributed run shows no chip here rather than
              a row of `unknown` noise — the facet above keeps its count on screen, the empty
              state names it, and the run's own detail header states it outright. */}
          {origin && (
            <Chip
              variant="origin"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-teal-400/60 hover:text-teal-200"
              title={`Declared by ${origin} — click to show only this library's runs`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectOrigin({ kind: 'origin', origin });
              }}
            >
              {originLabel(origin)}
            </Chip>
          )}
          {run.id.startsWith('dlq:') && (
            <Chip
              variant="danger"
              className="mono shrink-0 px-1 text-[9px] uppercase tracking-wider"
            >
              dlq
            </Chip>
          )}
        </span>
        <Badge status={state.status} />
      </div>
      {/* WHY it's parked, in domain terms — the signal/webhook/child token, the singleton leader,
        or the handler that has no live worker. Only for the derived waiting states. */}
      {state.detail && (
        <div className={`mono truncate text-[11px] s-${state.status}`}>{state.detail}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="mono truncate text-[11px] text-zinc-600">{run.id}</span>
        <span className="shrink-0 text-[11px] text-zinc-600">{relTime(run.updatedAt)}</span>
      </div>
      {run.tags && run.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {run.tags.map((t) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a nested <button> is invalid inside the row's own button — the row stays the keyboard target, the tag is a pointer shortcut for the same filter the sidebar field applies
            <span
              key={t}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTag(t);
              }}
              className={cn(
                badgeVariants({ variant: 'outline' }),
                'mono cursor-pointer hover:border-zinc-500 hover:text-zinc-200',
              )}
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
});

/** Roughly how tall a row is before it is measured, in px — the virtualiser's starting guess for
 *  rows it has not mounted yet. Every mounted row reports its real height back, so this only has to
 *  be close enough to keep the scrollbar from jumping. */
const ROW_ESTIMATE_PX = 86;

/** How many rows from the end the next page starts loading. Wide enough that a page lands before the
 *  operator reaches the bottom on a normal scroll, so the list reads as continuous rather than as a
 *  stall at every boundary. */
const LOAD_AHEAD_ROWS = 12;

function RunsList({
  runs,
  siblings,
  health,
  loading,
  selected,
  onSelect,
  onSelectTag,
  onSelectNamespace,
  onSelectOrigin,
  total,
  onLoadMore,
  loadingMore,
  emptyNotice,
}: {
  /** The loaded page, newest first. */
  runs: WorkflowRun[];
  /** The in-flight runs a singleton row is placed among — see `App`'s `singletonSiblings`. */
  siblings: WorkflowRun[];
  health: GroupHealth[];
  loading?: boolean;
  selected?: string | undefined;
  onSelect: (id?: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectNamespace: (namespace: string) => void;
  onSelectOrigin: (filter: OriginFilter) => void;
  /** How many runs match the current filters in total — the page is a window onto this. */
  total: number;
  /** Extend the page. Called by the scroll watcher below, never by the operator directly. */
  onLoadMore: () => void;
  /** Whether a fetch is in flight. Gates the watcher so scrolling cannot stack up requests. */
  loadingMore?: boolean | undefined;
  /** What to say when nothing matched — see `emptyRunsNotice`; an empty list must never read as
   *  "these runs do not exist" when the truth is "this filter cannot match them". */
  emptyNotice: ReturnType<typeof emptyRunsNotice>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // React keys these rows by run id, so the virtualiser has to key its size and element caches by the
  // same thing: otherwise a measurement stays attached to the SLOT instead of the row, and the poll
  // that keeps this list live reorders it — one run starting pushes every row down an index without
  // remounting any of them — leaving every offset computed from the height of whoever sat there
  // before. Depends on `runs` on purpose: when the contents change under an unchanged count, that new
  // identity is what tells the virtualiser to rebuild its measurements instead of reusing the last
  // set's.
  const getItemKey = useCallback((index: number) => runRowKey(runs, index), [runs]);
  // Only the rows in view are mounted. A control plane's list runs to thousands of rows, and mounting
  // them all is what made this pane freeze: ~12 DOM nodes per row put 115k nodes on the page, and
  // every poll then had to reconcile all of them.
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey,
    // Rows vary in height (tags wrap, the "why parked" line is conditional), so measure the real one
    // as each mounts instead of trusting the estimate.
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const more = total > runs.length;
  // The page grows as the last rows come into view. Driven off the VIRTUALISER rather than a scroll
  // handler or a sentinel element: the virtualiser already knows which rows are rendered, and it is
  // the only thing that knows it while rows are still being measured.
  const lastIndex = items.length > 0 ? (items[items.length - 1]?.index ?? -1) : -1;
  // The length the last request was fired at. Without it, a control plane whose `total` is momentarily
  // ahead of what `listRuns` returns (a run settled between the two queries) would re-fire on every
  // render forever, since the list never reaches the count the facets promised.
  const requestedAtLength = useRef(-1);
  useEffect(() => {
    const go = shouldLoadMore({
      hasMore: more,
      loading: Boolean(loadingMore),
      lastRenderedIndex: lastIndex,
      loadedCount: runs.length,
      requestedAtCount: requestedAtLength.current,
      loadAhead: LOAD_AHEAD_ROWS,
    });
    if (!go) return;
    requestedAtLength.current = runs.length;
    onLoadMore();
  }, [more, loadingMore, lastIndex, runs.length, onLoadMore]);

  if (loading && runs.length === 0) {
    return <RunsListSkeleton />;
  }
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-6 text-sm text-zinc-600">
        <span>{emptyNotice.message}</span>
        {emptyNotice.unclassified !== undefined && (
          <>
            <span className="text-[11px] text-zinc-500">
              {emptyNotice.unclassified} run{emptyNotice.unclassified === 1 ? '' : 's'} here{' '}
              {emptyNotice.unclassified === 1 ? 'has' : 'have'} no recorded origin, so no package
              filter can match {emptyNotice.unclassified === 1 ? 'it' : 'them'}.
            </span>
            <Button
              variant="chip"
              size="xs"
              className="mono rounded"
              title={UNKNOWN_ORIGIN_TITLE}
              onClick={() => onSelectOrigin({ kind: 'unknown' })}
            >
              show unclassified
            </Button>
          </>
        )}
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      {/* The separator is on the row, not `divide-y` on the list: virtualised children are absolutely
          positioned, so a sibling-combinator rule would drop the border on whichever row happens to be
          first in the window and move it as you scroll. */}
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const run = runs[item.index];
          if (!run) return null;
          return (
            <li
              key={run.id}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full border-b border-line-soft"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <RunRow
                run={run}
                siblings={siblings}
                health={health}
                selected={selected === run.id}
                onSelect={onSelect}
                onSelectTag={onSelectTag}
                onSelectNamespace={onSelectNamespace}
                onSelectOrigin={onSelectOrigin}
              />
            </li>
          );
        })}
      </ul>
      {/* The list is a page, so say so — an operator must never read the bottom of it as the end of
          the runs. The count is the server's, not the page's, and it is the only thing on screen that
          says more is coming while the next page is in flight. */}
      <div
        className="flex items-center gap-2 border-t border-line px-4 py-2"
        aria-live="polite"
        aria-busy={more && loadingMore}
      >
        <span className="mono text-[10px] text-zinc-600">
          {runs.length} of {total}
        </span>
        {more && (
          <span className="mono ml-auto text-[10px] text-zinc-600">
            {loadingMore ? 'loading…' : 'scroll for more'}
          </span>
        )}
      </div>
    </div>
  );
}

/** The saga-compensation group, rendered after the body timeline in unwind order (seq -1 first).
 *  Never mixes into the body graph/spans — this is its own amber-accented list. Each row is
 *  clickable into the SAME step-detail panel the body uses (`onSelect` just forwards to it), so a
 *  failed undo's input/output reads exactly like a normal step's. */
function CompensationSection({
  compensations,
  selKey,
  onSelect,
}: {
  compensations: StepCheckpoint[];
  selKey: string | undefined;
  onSelect: (step: StepCheckpoint) => void;
}) {
  return (
    <div className="shrink-0 border-t border-amber-500/20 bg-black/20 px-7 py-3">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.18em] text-amber-400/80">
        compensation · unwind order
      </div>
      <ul className="flex flex-col gap-1">
        {compensations.map((step) => {
          const key = `${step.runId}#${step.seq}`;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSelect(step)}
                className={`mono flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11.5px] transition-colors ${
                  key === selKey
                    ? 'border-amber-500/50 bg-amber-500/15'
                    : 'border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40'
                }`}
              >
                <StatusDot status={step.status} />
                <span className="truncate text-amber-100">
                  {compensationDisplayName(step.name)}
                </span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-amber-400/70">
                  {step.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The open run: header, graph, span timeline, step detail.
 *
 * Memoised on its two props (both stable — `id` is a string, `onOpenRun` a `useCallback`), so the run
 * list's poll every few seconds does NOT drag this subtree through a re-render. That matters because
 * the subtree is proportional to the run's step count: on the heaviest run measured (488 checkpoints)
 * an unmemoised parent render cost ~600ms of blocked main thread, several times a minute, while the
 * run itself had not changed at all. This pane re-renders on its OWN query now, which is exactly when
 * something about the run actually moved.
 */
const RunDetail = memo(function RunDetail({
  id,
  onOpenRun,
}: { id: string; onOpenRun: (id: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['run', id],
    // Merge over the cache instead of replacing it: the store only persists a step's `events` at
    // completion, so a refetch returns a still-running step empty — replacing would wipe the trail
    // the live stream appended (sub-processes flicker). Read prev AFTER the fetch so events that
    // streamed in during the request are kept too.
    queryFn: async () =>
      mergeLiveEvents(qc.getQueryData<RunDetailData>(['run', id]), await durableClient.run(id)),
    // Live-follow an in-flight run; stop polling once it reaches a terminal state.
    refetchInterval: (q) => {
      const s = (q.state.data as RunDetailData | undefined)?.run.status;
      return s === 'running' || s === 'suspended' ? 1500 : false;
    },
  });
  // Worker health + the sibling run list feed the SAME `deriveRunState` the list uses, so the detail
  // header agrees with the list row (no-worker / queued / awaiting) instead of the old timeline-only
  // guess. Shared query caches (same keys as the list/Workers panel) — no extra network.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  // The sibling set is only consulted when THIS run is a parked singleton, so ask for it only then.
  const openRun = (data as RunDetailData | undefined)?.run;
  const siblingRuns = useSingletonSiblings(openRun !== undefined && anySingleton([openRun]));
  // Dead-letter link: a `dead` run may have been routed to a `dlq:<id>` handler workflow. Probe for
  // it (retry off so a 404 just hides the link) so we never render a dead link.
  const handlerId =
    (data as RunDetailData | undefined)?.run.status === 'dead' ? `dlq:${id}` : undefined;
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
  const liveStatus = (data as RunDetailData | undefined)?.run.status;
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
        qc.setQueryData(['run', id], (prev: RunDetailData | undefined) => {
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
  // Manual recovery for a lost step dispatch (crashed worker / dropped job): re-dispatch every
  // remote step stuck `pending`. Reconcile-wake can't recover this on its own.
  const redispatch = useMutation({
    mutationFn: () => durableClient.redispatch(id),
    onSuccess: invalidate,
  });
  // Fix-and-replay: edit the input as JSON, then re-run as a fresh linked run.
  const fixReplay = useMutation({
    mutationFn: (input: unknown) => durableClient.retryWithInput(id, input),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      onOpenRun(r.runId);
    },
  });
  // Fix-and-replay editor state. This used to be `window.prompt` + `window.alert`: a single-line,
  // unstyled, un-resizable box for a multi-line JSON document, with the parse error arriving as a
  // second modal AFTER the edit was already discarded. The dialog keeps the draft on a parse error.
  const [fixOpen, setFixOpen] = useState(false);
  const [fixDraft, setFixDraft] = useState('');
  const [fixError, setFixError] = useState<string>();
  const onFixReplay = () => {
    setFixDraft(JSON.stringify((data as RunDetailData | undefined)?.run.input ?? {}, null, 2));
    setFixError(undefined);
    setFixOpen(true);
  };
  const submitFixReplay = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fixDraft);
    } catch (e) {
      setFixError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    setFixOpen(false);
    fixReplay.mutate(parsed);
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

  // Stable identity: `WorkflowGraph` and `SpansTimeline` are memoised, and a callback rebuilt each
  // render would defeat that — they would re-render (and re-lay-out every step) on any parent render.
  const toggleChild = useCallback((childId: string) => {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) {
        next.delete(childId);
      } else {
        next.add(childId);
      }
      return next;
    });
  }, []);
  const selectStep = useCallback((step: StepCheckpoint, stepRun: WorkflowRun) => {
    setSelStep({ step, run: stepRun });
  }, []);
  // Saga compensations (seq < 0, one per undone step, in reverse) never mix into the body's
  // graph/spans/step-count — split them out once, up front, and feed `body` to everything below that
  // renders the normal flow. `compensations` gets its own section further down.
  //
  // Memoised, and ABOVE the early return so it can be (hooks cannot follow one). `body` is the prop
  // the memoised graph and span timeline are keyed on, so rebuilding the array on every render would
  // re-lay-out every step of the run each time anything else on the page moved. React Query's
  // structural sharing keeps `data.timeline` identical across a poll that changed nothing, so this
  // recomputes exactly when the run's steps actually did.
  const split = useMemo(() => splitCompensations(data?.timeline ?? []), [data?.timeline]);

  if (!data) return <div className="p-8 text-sm text-zinc-600">Loading run…</div>;
  const { run } = data;
  const { body, compensations } = split;
  const compSummary = compensationSummary(compensations);
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
  // Compensation banner copy, mutually exclusive: still unwinding takes priority over the settled
  // outcome; a settled unwind reads differently for a failure than a cancellation. A failed undo
  // (exhausted retries) appends a suffix to whichever of the three applies — the run's own error
  // stays displayed as the ORIGINAL failure regardless.
  const compBanner =
    compensations.length > 0
      ? (() => {
          const failedSuffix =
            compSummary.failed > 0
              ? ` ${compSummary.failed} undo${compSummary.failed === 1 ? '' : 's'} failed after retries — check ${compSummary.failed === 1 ? 'it' : 'them'} below.`
              : '';
          if (compSummary.pending > 0) {
            return {
              title: 'Compensating',
              subtitle: `undoing completed steps in reverse (${compSummary.done} of ${compSummary.total} done).${failedSuffix}`,
            };
          }
          if (run.status === 'cancelled') {
            return {
              title: 'Cancelled with compensation',
              subtitle: `completed steps were undone before cancelling.${failedSuffix}`,
            };
          }
          return {
            title: 'Saga compensated',
            subtitle: `the run failed and its ${compSummary.total} completed step${compSummary.total === 1 ? '' : 's'} were undone in reverse.${failedSuffix}`,
          };
        })()
      : undefined;
  const canRetry = run.status === 'failed' || run.status === 'suspended';
  const canCancel = run.status === 'running' || run.status === 'suspended';
  // A suspended/running run may have a step in flight — the only shape a lost dispatch can hang on.
  const canRedispatch = run.status === 'suspended' || run.status === 'running';
  // Paused at a breakpoint = a pending `signal` checkpoint named `breakpoint:*` (see ctx.breakpoint).
  const atBreakpoint = body.some(
    (s) => s.status === 'pending' && s.kind === 'signal' && s.name.startsWith('breakpoint'),
  );
  // Stable key identifying the selected step across lanes (root + nested children); compensation
  // steps share the same `runId#seq` shape (seq just happens to be negative), so this works for both.
  const selKey = selStep ? `${selStep.step.runId}#${selStep.step.seq}` : undefined;
  // Same deriver as the list row (with the timeline for step-level precision) → header + list AGREE.
  const detailState = deriveRunState(run, { runs: siblingRuns, health, timeline: body });
  // Show the tenant/partition only when it's a real named one (not the single-pool `default`).
  const tenant = run.namespace && run.namespace !== 'default' ? run.namespace : undefined;
  // The declaring package, or `undefined` for UNKNOWN — which the header states outright rather
  // than omitting, so "we don't know" never reads as "the app".
  const origin = knownOrigin(run.origin);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-line px-7 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{run.workflow}</h2>
            {parentRunIdOf(run.id) !== undefined && (
              <Button
                variant="alt"
                size="xs"
                onClick={() => onOpenRun(parentRunIdOf(run.id) as string)}
                className="mono uppercase tracking-wider"
                title={`Open the parent run (${parentRunIdOf(run.id)}) — the macro view this child belongs to`}
              >
                ↑ parent
              </Button>
            )}
            {retryOriginOf(run.id) !== undefined && (
              <Button
                variant="chip"
                size="xs"
                onClick={() => onOpenRun(retryOriginOf(run.id) as string)}
                className="mono uppercase tracking-wider text-zinc-300"
                title={`This is a retry-with-input of ${retryOriginOf(run.id)} — open the original run`}
              >
                ↩ original
              </Button>
            )}
            {isDlqHandler && (
              <Chip variant="danger" className="mono py-0.5 uppercase tracking-wider">
                dlq
              </Chip>
            )}
            <Badge status={detailState.status} />
            {detailState.detail && (
              <span className={`mono text-[11px] s-${detailState.status}`}>
                {detailState.detail}
              </span>
            )}
            {tenant && (
              <Chip
                variant="tenant"
                className="mono py-0.5"
                title="Tenant / worker-pool partition this run belongs to"
              >
                {tenant}
              </Chip>
            )}
            {/* WHICH LIBRARY declared this workflow — stated on every run, including the ones nobody
                could attribute. Unlike the list row (dense, scannable), the detail view has room to
                be explicit, and "unknown" is the honest answer here: not the host app, not blank. */}
            {origin ? (
              <Chip variant="origin" className="mono py-0.5" title={`Declared by ${origin}`}>
                {originLabel(origin)}
              </Chip>
            ) : (
              <Chip variant="origin-unknown" className="mono py-0.5" title={UNKNOWN_ORIGIN_TITLE}>
                origin {UNKNOWN_ORIGIN}
              </Chip>
            )}
            {compensations.length > 0 && (
              <Chip
                variant="warn"
                className={cn(
                  'mono py-0.5 uppercase tracking-wider',
                  compSummary.pending > 0 && 'pulse',
                )}
                title={
                  compSummary.pending > 0
                    ? `compensating: ${compSummary.done} of ${compSummary.total} undone`
                    : `${compSummary.total} step${compSummary.total === 1 ? '' : 's'} compensated`
                }
              >
                {compSummary.pending > 0 ? 'compensating' : 'compensated'}
              </Chip>
            )}
            <Chip className="mono bg-transparent py-0.5 text-zinc-500">v{run.workflowVersion}</Chip>
            <span className="mono tnum text-[11px] text-zinc-600">
              {body.length} {body.length === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="mono mt-1 truncate text-[11px] text-zinc-600">{run.id}</div>
          {run.tags && run.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {run.tags.map((t) => (
                <Chip key={t} className="mono">
                  #{t}
                </Chip>
              ))}
            </div>
          )}
          {run.searchAttributes && Object.keys(run.searchAttributes).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(run.searchAttributes).map(([k, v]) => (
                <Chip key={k} variant="attr" className="mono" title="search attribute">
                  {k}={String(v)}
                </Chip>
              ))}
            </div>
          )}
          {(data as RunDetailData | undefined)?.children?.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-zinc-600">children:</span>
              {(data as RunDetailData).children?.map((cid) => (
                <Button
                  key={cid}
                  variant="chip"
                  size="xs"
                  onClick={() => onOpenRun(cid)}
                  className="mono px-1.5 py-0"
                >
                  {cid}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            onClick={() => setShowRunIO(true)}
            className="mono px-2.5 normal-case tracking-normal text-zinc-400"
            title="Run input / output"
          >
            {'{ }'}
          </Button>
          {atBreakpoint && (
            <Button variant="warn" disabled={cont.isPending} onClick={() => cont.mutate()}>
              <PlayIcon width={12} height={12} />
              Continue
            </Button>
          )}
          <Button
            variant="brand"
            disabled={!canRetry || retry.isPending}
            onClick={() => retry.mutate()}
          >
            <RetryIcon width={12} height={12} />
            Retry
          </Button>
          {canRedispatch && (
            <Button
              variant="info"
              disabled={redispatch.isPending}
              onClick={() => redispatch.mutate()}
              title="Re-dispatch stuck `pending` remote steps — recovery for a lost step dispatch (crashed worker or dropped job)"
            >
              <BoltIcon width={12} height={12} />
              Re-dispatch
            </Button>
          )}
          {(run.status === 'dead' || run.status === 'failed') && (
            <Button
              variant="alt"
              disabled={fixReplay.isPending}
              onClick={onFixReplay}
              title="Edit the input and re-run as a fresh linked run"
            >
              <RetryIcon width={12} height={12} />
              Fix &amp; replay
            </Button>
          )}
          {canCancel && (
            <Button
              variant="warn"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(true)}
              title="Cancel and run saga compensations (undo completed steps in reverse)"
              className="bg-transparent"
            >
              <RetryIcon width={12} height={12} />
              Cancel + Undo
            </Button>
          )}
          <Button
            className="border-zinc-700"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate(false)}
          >
            <XIcon width={12} height={12} />
            Cancel
          </Button>
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
          <Button
            variant="danger"
            onClick={() => onOpenRun(dlqLink.id)}
            className="mono shrink-0 border-rose-500/40 bg-rose-500/15 px-2.5 text-[11px] normal-case tracking-normal text-rose-200 enabled:hover:bg-rose-500/25"
          >
            {dlqLink.cta}
          </Button>
        </div>
      )}
      {compBanner && (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-7 py-3">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-amber-500/40 bg-amber-500/15 text-sm text-amber-300"
            aria-hidden
          >
            ↺
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-amber-200">{compBanner.title}</div>
            <div className="mono truncate text-[11px] text-amber-300/70">{compBanner.subtitle}</div>
          </div>
        </div>
      )}
      <div
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateRows: body.length > 0 ? `1fr ${spanHeight}px` : '1fr' }}
      >
        <div className="relative min-h-0">
          {body.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-zinc-600">
              No steps recorded yet.
            </div>
          ) : (
            <WorkflowGraph
              run={run}
              timeline={body}
              endStatus={detailState.status}
              selectedKey={selKey}
              onSelect={selectStep}
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
        {body.length > 0 && (
          // The spans height lives in the GRID TRACK above (`clamp(...)`), not here — an `auto` track
          // sizes to the tall span content's min-content and collapses the `1fr` WorkflowGraph row to
          // 0. With the track clamped, this wrapper just fills it and clips; SpansTimeline scrolls.
          <div className="relative min-h-0 overflow-hidden border-t border-line bg-black/20">
            {/* Drag the top edge to resize the spans panel. */}
            <div
              onPointerDown={onResizeSpans}
              className="absolute inset-x-0 top-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-brand/40"
              title="Drag to resize"
            />
            <SpansTimeline
              run={run}
              timeline={body}
              selectedKey={selKey}
              onSelect={selectStep}
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
      {compensations.length > 0 && (
        <CompensationSection
          compensations={compensations}
          selKey={selKey}
          onSelect={(step) => setSelStep({ step, run })}
        />
      )}
      <Dialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        title="Fix & replay"
        subtitle={`re-runs ${run.id} as a fresh linked run`}
        footer={
          <>
            <Button onClick={() => setFixOpen(false)}>Cancel</Button>
            <Button variant="alt" disabled={fixReplay.isPending} onClick={submitFixReplay}>
              Replay
            </Button>
          </>
        }
      >
        <label
          className="mono mb-1.5 block text-[10px] uppercase tracking-[0.18em] text-zinc-500"
          htmlFor="fix-replay-input"
        >
          input
        </label>
        <textarea
          id="fix-replay-input"
          value={fixDraft}
          spellCheck={false}
          onChange={(e) => {
            setFixDraft(e.target.value);
            setFixError(undefined);
          }}
          className="mono h-64 w-full resize-y rounded-lg border border-line bg-black/40 p-3 text-[11.5px] leading-relaxed text-zinc-300 focus:border-zinc-600 focus:outline-none"
        />
        {fixError && (
          <p className="mono mt-2 rounded border border-bad/25 bg-bad/10 px-2 py-1 text-[11px] text-bad">
            {fixError}
          </p>
        )}
      </Dialog>
    </div>
  );
});

/** The open run id encoded in the URL hash (`#/run/<id>`) — so a run is deep-linkable / shareable. */
function runIdFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.hash.match(/^#\/run\/(.+)$/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : undefined;
}

/** Whether any of these runs is parked as a singleton — the only case whose display state needs the
 *  sibling set at all. On a deployment that uses no singletons this is always false, so the query
 *  below never runs. */
function anySingleton(runs: readonly WorkflowRun[]): boolean {
  return runs.some(
    (r) => r.status === 'suspended' && r.tags?.some((t) => t.startsWith('singleton:')),
  );
}

/**
 * The IN-FLIGHT runs a singleton row is placed among — `deriveRunState` picks the oldest of them as
 * the leader, exactly as the engine's `admit()` does.
 *
 * Fetched as its own bounded query rather than reusing whatever list is on screen, because both
 * callers now hold a PAGE and the leader is by definition the oldest sibling — the row most likely to
 * have fallen off it. In-flight is the working set, not the history, so this stays small no matter how
 * many runs a control plane has accumulated. One `queryKey` for both callers, so the list and an open
 * run share a single fetch.
 */
function useSingletonSiblings(needed: boolean): WorkflowRun[] {
  const { data = [] } = useQuery({
    queryKey: ['runs', 'in-flight'],
    queryFn: () =>
      durableClient.runs(undefined, undefined, undefined, {
        statuses: SINGLETON_INFLIGHT_STATUSES,
        limit: 500,
      }),
    enabled: needed,
    refetchInterval: 5000,
  });
  return data;
}

/**
 * How many runs one page of the list holds. Bounded deliberately: a control plane accumulates runs
 * for as long as its retention policy keeps them (tens of thousands is ordinary), and an unbounded
 * listing costs the browser both the transfer and a DOM node per row. 100 fills the pane several
 * times over; "show more" raises the ceiling for an operator who wants to scroll further back.
 */
const PAGE_SIZE = 100;

export function App() {
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  // Arrays, not strings: each of these controls takes SEVERAL values, ORed within the axis and
  // ANDed across them — comparing two tenants, or two tags, is one query rather than two views.
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [attrFilter, setAttrFilter] = useState<string[]>([]);
  // Empty = EVERY tenant, and that default is deliberate: core keeps read paths namespace-unscoped,
  // so an operator who has always seen every tenant's runs keeps seeing them until they narrow.
  const [namespaceFilter, setNamespaceFilter] = useState<string[]>([]);
  // Origin is faceted in the browser (see OriginFacets) — it is the only filter here that must be
  // able to select ABSENCE, which an exact-match `RunQuery.origin` cannot express.
  const [originFilter, setOriginFilter] = useState<OriginFilter>(ALL_ORIGINS);
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
  // How many pages of the list are loaded, and for WHICH result set. One piece of state rather than
  // two, so that `pages` can be DERIVED below: reset it from an effect instead and the render that
  // changes the filters still asks for every page the previous view had loaded, spending a request on
  // a result the next render throws away.
  const [paging, setPaging] = useState({ key: '', pages: 1 });
  const qc = useQueryClient();
  // `key:op:value` predicates (e.g. `amount:gte:200`, `tier:in:pro|enterprise`), ANDed server-side.
  const attrPredicates = attrFilter;
  const attrKey = attrPredicates.join('|');
  // `undefined` = every origin; `null` = the unattributed bucket, which needs its own spelling because
  // no string value matches a run that has no origin. Both go to the SERVER now: with a paged list, a
  // facet applied in the browser would filter the page rather than the deployment.
  const originParam =
    originFilter.kind === 'origin'
      ? originFilter.origin
      : originFilter.kind === 'unknown'
        ? null
        : undefined;
  const originKey = originFilterKey(originFilter);
  // Identity for the run list's `key` (see the `<RunsList key=…>` usage below) — every filter that
  // changes which runs the list contains.
  const runsListResetKey = runsFilterKey({
    status: filter,
    tag: tagFilter.join('|'),
    attrs: attrKey,
    namespace: namespaceFilter.join('|'),
    origin: originKey,
  });
  // Landing 900 rows into a set the operator just re-scoped would be a non-sequitur, so a page count
  // recorded against another result set counts for nothing: every filter change starts at page one.
  const pages = paging.key === runsListResetKey ? paging.pages : 1;
  const limit = PAGE_SIZE * pages;
  const {
    data: runs = [],
    isPending: runsPending,
    isFetching: runsFetching,
  } = useQuery({
    queryKey: ['runs', filter, tagFilter, attrKey, namespaceFilter, originKey, limit],
    queryFn: () =>
      durableClient.runs(
        filter === 'all' ? undefined : filter,
        tagFilter,
        attrPredicates.length ? attrPredicates : undefined,
        // An empty selection sends NO `namespace` predicate — all tenants, the historical default.
        { namespace: namespaceFilter, origin: originParam, limit },
      ),
    refetchInterval: 3000, // keep the run list live
    // "Show more" and every filter change move the query key. Without this the list would blank back
    // to its skeleton on each one, which reads as "the runs went away" rather than "loading more".
    placeholderData: keepPreviousData,
  });
  // The chips' numbers, counted server-side over the WHOLE matching set. This is what makes paging the
  // list safe: the page bounds what is rendered, never what the operator is told exists.
  const { data: facets = [] } = useQuery({
    queryKey: ['run-facets', tagFilter, attrKey, namespaceFilter],
    queryFn: () =>
      durableClient.facets(
        tagFilter,
        attrPredicates.length ? attrPredicates : undefined,
        namespaceFilter,
      ),
    refetchInterval: 5000,
  });
  // What each picker OFFERS: the values these runs actually carry, counted server-side.
  //
  // Each picker's scope EXCLUDES its own axis. Including it would make the list collapse to what is
  // already selected the moment an operator picks a value — a control that can only ever be narrowed
  // once. Every other axis is included, so the offered values are the ones that would return runs.
  const originScope =
    originFilter.kind === 'unknown'
      ? null
      : originFilter.kind === 'origin'
        ? originFilter.origin
        : undefined;
  const tagScope = useMemo(
    () => ({ namespace: namespaceFilter, attr: attrFilter, origin: originScope }),
    [namespaceFilter, attrFilter, originScope],
  );
  const namespaceScope = useMemo(
    () => ({ tag: tagFilter, attr: attrFilter, origin: originScope }),
    [tagFilter, attrFilter, originScope],
  );
  const attrScope = useMemo(
    () => ({ tag: tagFilter, namespace: namespaceFilter, origin: originScope }),
    [tagFilter, namespaceFilter, originScope],
  );
  const { data: tagValues = [] } = useQuery({
    queryKey: ['run-values', 'tag', tagScope],
    queryFn: () => durableClient.values('tag', tagScope),
    staleTime: 10_000,
  });
  const { data: namespaceValues = [] } = useQuery({
    queryKey: ['run-values', 'namespace', namespaceScope],
    queryFn: () => durableClient.values('namespace', namespaceScope),
    staleTime: 10_000,
  });
  // A `null` value belongs to an axis with an absent bucket (origin) — neither of these has one, and
  // a picker cannot offer "no value" as something to type anyway.
  const tagOptions = useMemo(() => selectableValues(tagValues), [tagValues]);
  const namespaceOptions = useMemo(() => selectableValues(namespaceValues), [namespaceValues]);

  // Worker health, joined into each run row (no-worker) and the banner. Shares the `['workers']` cache
  // with the Workers panel (same queryKey → one fetch); polled a touch faster so "no worker" clears
  // promptly once a worker rejoins.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  const bulk = useMutation({
    mutationFn: (action: 'retry' | 'cancel') =>
      durableClient.bulk(action, {
        status: filter !== 'all' ? filter : undefined,
        tag: tagFilter,
        attr: attrPredicates.length ? attrPredicates : undefined,
        namespace: namespaceFilter,
        // Every facet the operator can see, INCLUDING the unattributed bucket — `origin: null` is sent
        // as its own param, so a bulk action is scoped to exactly the set the list was showing.
        origin: originParam,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });

  // Status chips, from the server's facet counts pivoted onto the lit origin chip — so the two chip
  // rows agree with each other AND with the whole matching set, not with the page on screen.
  const counts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const cell of facets) {
      if (!matchesOrigin({ origin: cell.origin ?? undefined }, originFilter)) continue;
      acc[cell.status] = (acc[cell.status] ?? 0) + cell.count;
    }
    return acc;
  }, [facets, originFilter]);
  // Counted over EVERY origin — the whole point is to be able to say "these N runs cannot be matched
  // by any package filter" at the moment a package filter shows nothing.
  const unattributed = useMemo(() => unknownCountFromFacets(facets), [facets]);
  // How many runs the current filters match in total, so the list can say what it is NOT showing.
  // Scoped by the lit STATUS chip as well as the origin one, or "show more" would offer to load runs
  // the query cannot return and the summary line would count runs that are not in the list.
  const matchedTotal = useMemo(
    () =>
      filter === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[filter] ?? 0),
    [counts, filter],
  );
  const anyFilter =
    filter !== 'all' ||
    tagFilter.length > 0 ||
    namespaceFilter.length > 0 ||
    attrPredicates.length > 0 ||
    originFilter.kind !== 'all';
  const originChips = useMemo(() => originFacetsFromCounts(facets), [facets]);
  // Workflows whose queue has backlog and no worker consuming it — surfaced as a banner so it's
  // obvious nothing will progress until a worker rejoins (the "control plane up, no worker" case).
  const stalled = useMemo(() => stalledWorkflows(health), [health]);

  const singletonSiblings = useSingletonSiblings(useMemo(() => anySingleton(runs), [runs]));

  // A chip on a run row ADDS its value to the picker rather than replacing the selection: clicking a
  // second tag on a second row is how an operator builds "these two kinds of run", and replacing
  // would make the first click undo the second.
  const addTag = useCallback((tag: string) => {
    setTagFilter((current) => (current.includes(tag) ? current : [...current, tag]));
  }, []);
  const addNamespace = useCallback((namespace: string) => {
    setNamespaceFilter((current) =>
      current.includes(namespace) ? current : [...current, namespace],
    );
  }, []);

  const loadMore = useCallback(() => {
    setPaging((p) => ({
      key: runsListResetKey,
      pages: p.key === runsListResetKey ? p.pages + 1 : 2,
    }));
  }, [runsListResetKey]);

  return (
    <TooltipProvider>
      <div className="app-bg" />
      <div className="relative z-10 flex h-full flex-col">
        <Header counts={counts} filter={filter} onFilter={setFilter} />
        {stalled.length > 0 && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200">
            <span className="s-no-worker inline-flex items-center gap-1.5">
              <span className="dot s-no-worker" aria-hidden />
            </span>
            <span>
              Runs waiting on handlers with no live worker:{' '}
              <span className="mono text-amber-100">{stalled.join(', ')}</span>. Start a worker to
              unblock.
            </span>
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,360px)_1fr]">
          <aside className="flex min-h-0 flex-col border-r border-line">
            <div className="border-b border-line p-2">
              <MultiSelect
                glyph="#"
                label="filter by tag"
                placeholder="filter by tag…"
                value={tagFilter}
                onChange={setTagFilter}
                options={tagOptions}
                title="Tags carried by a run (WorkflowRun.tags). Several match ANY of them."
              />
              <div className="mt-1.5">
                <MultiSelect
                  glyph="@"
                  label="filter by tenant"
                  placeholder="filter by tenant / namespace…"
                  value={namespaceFilter}
                  onChange={setNamespaceFilter}
                  options={namespaceOptions}
                  title="Tenant / worker-pool partition (WorkflowRun.namespace). None selected shows every tenant."
                />
              </div>
              <AttributeFilters value={attrFilter} onChange={setAttrFilter} scope={attrScope} />
            </div>
            <OriginFacets facets={originChips} value={originFilter} onChange={setOriginFilter} />
            {anyFilter && matchedTotal > 0 && (
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                <span className="mono text-[10px] text-zinc-500">
                  {matchedTotal} {filter !== 'all' ? filter : ''}
                  {tagFilter.length > 0 && ` #${tagFilter.join(', ')}`}
                  {namespaceFilter.length > 0 && ` @${namespaceFilter.join(', ')}`}
                  {originFilter.kind === 'origin' && ` ⬡${originLabel(originFilter.origin)}`}
                  {originFilter.kind === 'unknown' && ` ⬡${UNKNOWN_ORIGIN}`}
                  {attrPredicates.length > 0 && ` ⛃${attrPredicates.length}`}
                </span>
                <Button
                  variant="brand"
                  size="xs"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate('retry')}
                  className="mono ml-auto rounded"
                >
                  retry all
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate('cancel')}
                  className="mono rounded"
                >
                  cancel all
                </Button>
              </div>
            )}
            <RunsList
              // Remounts on any filter change: cheap for this list size, and it's the simplest way to
              // reset BOTH the virtualiser's scroll position and its row-height cache — a stale scroll
              // offset from the pre-filter list would otherwise leave the view scrolled deep into a
              // now much shorter one.
              key={runsListResetKey}
              runs={runs}
              siblings={singletonSiblings}
              health={health}
              loading={runsPending}
              selected={selected}
              onSelect={setSelected}
              onSelectTag={addTag}
              onSelectNamespace={addNamespace}
              onSelectOrigin={setOriginFilter}
              total={matchedTotal}
              onLoadMore={loadMore}
              loadingMore={runsFetching}
              emptyNotice={emptyRunsNotice({
                anyFilter,
                origin: originFilter,
                unknownCount: unattributed,
              })}
            />
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
    </TooltipProvider>
  );
}
