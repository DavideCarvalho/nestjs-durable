import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../../aviary-kit/blocks/error-boundary';
import { Skeleton } from '../../aviary-kit/ui/skeleton';
import {
  type FanSummary,
  type RunDetail as RunDetailData,
  type StepCheckpoint,
  type WorkflowRun,
  deriveRunState,
  durableClient,
} from '../../client/durable-client';
import { EventTail } from '../../client/event-tail';
import { appendLiveEvent, mergeLiveEvents } from '../../client/merge-live-events';
import {
  UNKNOWN_ORIGIN,
  UNKNOWN_ORIGIN_TITLE,
  knownOrigin,
  originLabel,
} from '../../client/run-origin';
import {
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from '../../client/split-compensations';
import { throttle } from '../../client/throttle';
import { RunEvents } from '../RunEvents';
import { RunInfoPanel } from '../RunInfoPanel';
import {
  LifecycleDeliveries,
  LifecycleSourceLine,
  RunWaits,
  withTriggerErrors,
} from '../RunLifecycle';
import { SpansTimeline } from '../SpansTimeline';
import { StepDetailPanel } from '../StepDetailPanel';
import { WorkflowGraph } from '../WorkflowGraph';
import { WorkflowLifecycleLists, workflowHash } from '../WorkflowLifecycle';
import { useCapabilities } from '../capabilities';
import { childChips, triggerChips } from '../child-link';
import { BoltIcon, PlayIcon, RetryIcon, XIcon } from '../icons';
import { parentRunIdOf, retryOriginOf } from '../run-lineage';
import { StatusBadge as Badge, StatusDot, durMs } from '../run-status';
import { Badge as Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Dialog } from '../ui/dialog';
import { anySingleton, useSingletonSiblings } from './singleton';

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
    <div className="shrink-0 border-t border-warn/20 bg-sunken/20 px-4 py-3 md:px-6">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.18em] text-warn/80">
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
                    ? 'border-warn/50 bg-warn/15'
                    : 'border-warn/20 bg-warn/5 hover:border-warn/40'
                }`}
              >
                <StatusDot status={step.status} />
                <span className="truncate text-warn">{compensationDisplayName(step.name)}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-warn/70">
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

/** Stand-in for the run detail while it loads: header lines, actions, the graph block. */
function RunDetailSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-hidden data-run-detail-skeleton="">
      <div className="flex flex-col gap-2.5 border-b border-border px-4 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="ml-auto hidden h-8 w-48 xl:block" />
        </div>
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="flex-1 p-6">
        <Skeleton className="h-full min-h-40 w-full rounded-lg" />
      </div>
    </div>
  );
}

/** Stable empty list, for a run whose detail summarized no fans. */
const NO_FANS: FanSummary[] = [];

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
export const RunDetail = memo(function RunDetail({
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
  // Live-tail over SSE while the page is open: every event goes to the Events panel's in-memory
  // tail, and an event refreshes the detail instead of waiting for the poll while the run is in
  // flight, or when a settled run starts (or fails to start) a lifecycle subscriber. The 1.5s poll
  // above stays as a fallback (e.g. transport with no control plane, or a dropped stream).
  const liveStatus = (data as RunDetailData | undefined)?.run.status;
  const isLive = liveStatus === 'running' || liveStatus === 'suspended';
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  // One per open run: the pane is keyed by run id, so another run mounts a fresh one.
  const [eventTail] = useState(() => new EventTail());
  // The messages of the `run.trigger_failed` events seen while the page is open, by subscriber: the
  // run's tags record only that a subscriber failed, so its delivery row borrows the reason here.
  const [triggerErrors, setTriggerErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    // A busy fan emits a lifecycle event per member; refetching the detail on each would fetch it
    // back-to-back. At most one refetch per poll interval, the last event always followed by one.
    const refetch = throttle(() => qc.invalidateQueries({ queryKey: ['run', id] }), 1500);
    const stop = durableClient.streamRun(id, (event) => {
      eventTail.push(event);
      if (event.type === 'run.trigger_failed' && event.name && event.error?.message) {
        const { name, error } = event;
        setTriggerErrors((prev) => ({ ...prev, [name]: error.message }));
      }
      // `step.progress` carries a single live event from a still-running step — merge it straight
      // into the cached step's `events` so a long step's trail streams in line-by-line. Invalidating
      // per event would mean a store refetch per log line (hundreds for a fan-out step) AND would
      // show nothing until the step completes, since the store only gets `events` at completion.
      if (event.type === 'step.progress' && event.event && event.seq != null) {
        const seq = event.seq;
        const live = event.event;
        qc.setQueryData(['run', id], (prev: RunDetailData | undefined) =>
          appendLiveEvent(prev, seq, live),
        );
        return;
      }
      // Lifecycle events (step started/completed, run settled) change authoritative state — refetch.
      if (
        isLiveRef.current ||
        event.type === 'run.triggered' ||
        event.type === 'run.trigger_failed'
      ) {
        refetch.call();
      }
    });
    return () => {
      refetch.cancel();
      stop();
    };
  }, [id, eventTail, qc]);
  const retry = useMutation({ mutationFn: () => durableClient.retry(id), onSuccess: invalidate });
  const cancel = useMutation({
    mutationFn: (compensate?: boolean) =>
      durableClient.cancel(id, compensate !== undefined ? { compensate } : {}),
    onSuccess: invalidate,
  });
  const cont = useMutation({ mutationFn: () => durableClient.continue(id), onSuccess: invalidate });
  const can = useCapabilities();
  // Manual recovery for a lost step dispatch (crashed worker / dropped job): re-dispatch every
  // remote step stuck `pending`. Reconcile-wake can't recover this on its own.
  const redispatch = useMutation({
    mutationFn: () => durableClient.redispatch(id),
    onSuccess: invalidate,
  });
  // Republish a settled run's lifecycle event to the subscribers that have not started from it.
  const [republishOpen, setRepublishOpen] = useState(false);
  const republish = useMutation({
    mutationFn: () => durableClient.republishLifecycle(id),
    onSuccess: invalidate,
  });
  // Retry one failed subscriber from its delivery row.
  const republishOne = useMutation({
    mutationFn: (subscriber: string) => durableClient.republishLifecycle(id, subscriber),
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
  const fans = data?.fans ?? NO_FANS;

  if (!data) return <RunDetailSkeleton />;
  const { run } = data;
  const { body, compensations } = split;
  // A summarized fan's members are not in `body`; the step count and the "anything to draw" checks
  // count them through the fan.
  const stepCount = fans.reduce((n, fan) => n + fan.size, body.length);
  const hasFlow = body.length > 0 || fans.length > 0;
  const chips = childChips(data.children ?? [], data.childCount);
  const triggers = triggerChips(data);
  const startedBy = triggers.startedBy;
  const lifecycleSubscribers = data.lifecycleSubscribers ?? [];
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
  // The declaring package, or `undefined` for the app's own workflow — which the header states
  // outright (as `origin app`) rather than omitting.
  const origin = knownOrigin(run.origin);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 md:px-6 xl:flex-row xl:items-start xl:justify-between xl:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-fg">
              <a
                href={workflowHash(run.workflow)}
                className="underline-offset-4 hover:underline"
                title="Open this workflow's page: who starts when it settles, and who starts it"
              >
                {run.workflow}
              </a>
            </h2>
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
                className="mono uppercase tracking-wider text-fg-2"
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
            {run.tenantId && (
              <Chip
                variant="organization"
                className="py-0.5"
                title={`Organization (customer tenant) this run belongs to${
                  run.tenantKind ? ` · ${run.tenantKind}` : ''
                } · ${run.tenantId}`}
              >
                {run.tenantLabel ?? run.tenantId}
              </Chip>
            )}
            {/* WHICH LIBRARY declared this workflow — stated on every run, including the ones nobody
                declared without a package. Unlike the list row (dense, scannable), the detail view has
                room to be explicit: a run with no package origin is the app's own, so it says `app`. */}
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
            <Chip className="mono bg-transparent py-0.5 text-dim">v{run.workflowVersion}</Chip>
            <span className="mono tnum text-[11px] text-faint">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="mono mt-1 truncate text-[11px] text-faint">{run.id}</div>
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
          {chips.shown.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-faint">children:</span>
              {chips.shown.map((cid) => (
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
              {chips.more > 0 && (
                <span className="mono text-[10px] text-dim">+{chips.more} more</span>
              )}
            </div>
          ) : null}
          {startedBy ? <LifecycleSourceLine source={startedBy} onOpenRun={onOpenRun} /> : null}
          <RunWaits waitsFor={data.waitsFor} awaitedBy={data.awaitedBy} onOpenRun={onOpenRun} />
          {triggers.triggered.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-faint">triggered:</span>
              {triggers.triggered.map((tid) => (
                <Button
                  key={tid}
                  variant="chip"
                  size="xs"
                  onClick={() => onOpenRun(tid)}
                  className="mono px-1.5 py-0"
                >
                  {tid}
                </Button>
              ))}
            </div>
          ) : null}
          {data.lifecycleDeliveries ? (
            <LifecycleDeliveries
              deliveries={withTriggerErrors(data.lifecycleDeliveries, triggerErrors)}
              onOpenRun={onOpenRun}
              onRepublish={(subscriber) => republishOne.mutate(subscriber)}
              republishing={republishOne.isPending}
            />
          ) : null}
          {data.workflowLifecycle ? (
            <div className="mt-3">
              <WorkflowLifecycleLists links={data.workflowLifecycle} />
            </div>
          ) : null}
          <RunEvents
            tail={eventTail}
            sourceRunId={startedBy?.runId}
            parentRunId={parentRunIdOf(run.id)}
            onOpenRun={onOpenRun}
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            onClick={() => setShowRunIO(true)}
            className="mono px-2.5 normal-case tracking-normal text-dim"
            title="Run input / output"
          >
            {'{ }'}
          </Button>
          {atBreakpoint && can('breakpoints') && (
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
          {canRedispatch && can('redispatch') && (
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
          {lifecycleSubscribers.length > 0 && can('republishLifecycle') && (
            <Button
              variant="info"
              disabled={republish.isPending}
              onClick={() => {
                republish.reset();
                setRepublishOpen(true);
              }}
              title="Start the lifecycle-event subscribers that have not started from this run"
            >
              <BoltIcon width={12} height={12} />
              Republish lifecycle event
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
            className="border-line-strong"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate(false)}
          >
            <XIcon width={12} height={12} />
            Cancel
          </Button>
        </div>
      </div>
      {dlqLink && (
        <div className="flex items-center gap-3 border-b border-bad/30 bg-bad/10 px-4 py-3 md:px-6">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-bad/40 bg-bad/15 text-sm text-bad"
            aria-hidden
          >
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-bad">{dlqLink.title}</div>
            <div className="mono truncate text-[11px] text-bad/70">{dlqLink.subtitle}</div>
          </div>
          <Button
            variant="danger"
            onClick={() => onOpenRun(dlqLink.id)}
            className="mono shrink-0 border-bad/40 bg-bad/15 px-2.5 text-[11px] normal-case tracking-normal text-bad enabled:hover:bg-bad/25"
          >
            {dlqLink.cta}
          </Button>
        </div>
      )}
      {compBanner && (
        <div className="flex items-center gap-3 border-b border-warn/30 bg-warn/10 px-4 py-3 md:px-6">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-warn/40 bg-warn/15 text-sm text-warn"
            aria-hidden
          >
            ↺
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-warn">{compBanner.title}</div>
            <div className="mono truncate text-[11px] text-warn/70">{compBanner.subtitle}</div>
          </div>
        </div>
      )}
      <div
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateRows: hasFlow ? `1fr ${spanHeight}px` : '1fr' }}
      >
        <div className="relative min-h-0">
          {!hasFlow ? (
            <div className="grid h-full place-items-center text-sm text-faint">
              No steps recorded yet.
            </div>
          ) : (
            <ErrorBoundary label="Workflow graph" resetKeys={[id]}>
              <WorkflowGraph
                run={run}
                timeline={body}
                fans={fans}
                endStatus={detailState.status}
                selectedKey={selKey}
                onSelect={selectStep}
                onOpenRun={onOpenRun}
                fmtDuration={durMs}
                expanded={expandedChildren}
                onToggleChild={toggleChild}
              />
            </ErrorBoundary>
          )}
          {(run.status === 'failed' || run.status === 'cancelled') && run.error && (
            <div className="mono absolute inset-x-6 bottom-6 rounded-lg border border-bad/20 bg-bad/10 px-3 py-2 text-xs text-bad backdrop-blur">
              {run.error.message}
            </div>
          )}
        </div>
        {hasFlow && (
          // The spans height lives in the GRID TRACK above (`clamp(...)`), not here — an `auto` track
          // sizes to the tall span content's min-content and collapses the `1fr` WorkflowGraph row to
          // 0. With the track clamped, this wrapper just fills it and clips; SpansTimeline scrolls.
          <div className="relative min-h-0 overflow-hidden border-t border-line bg-sunken/20">
            {/* Drag the top edge to resize the spans panel. */}
            <div
              onPointerDown={onResizeSpans}
              className="absolute inset-x-0 top-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-brand/40"
              title="Drag to resize"
            />
            <ErrorBoundary label="Spans" resetKeys={[id]}>
              <SpansTimeline
                run={run}
                timeline={body}
                fans={fans}
                selectedKey={selKey}
                onSelect={selectStep}
                onOpenRun={onOpenRun}
                expanded={expandedChildren}
                onToggleChild={toggleChild}
              />
            </ErrorBoundary>
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
        open={republishOpen}
        onOpenChange={setRepublishOpen}
        title="Republish lifecycle event"
        subtitle={`publishes ${run.id}'s ${run.status === 'completed' ? 'run.completed' : 'run.failed'} event again`}
        footer={
          republish.isSuccess || republish.isError ? (
            <Button onClick={() => setRepublishOpen(false)}>Close</Button>
          ) : (
            <>
              <Button onClick={() => setRepublishOpen(false)}>Cancel</Button>
              <Button
                variant="info"
                disabled={republish.isPending}
                onClick={() => republish.mutate()}
              >
                Republish
              </Button>
            </>
          )
        }
      >
        <p className="text-[12px] text-dim">
          Subscribers: <span className="mono text-fg-2">{lifecycleSubscribers.join(', ')}</span>.
          The ones already started from this run are not started again.
        </p>
        {republish.isSuccess && (
          <div className="mono mt-3 space-y-1 text-[11.5px] text-fg-2">
            <p>
              started {republish.data.started} subscriber run
              {republish.data.started === 1 ? '' : 's'}
            </p>
            {republish.data.failed.map((f) => (
              <p
                key={f.subscriber}
                className="rounded border border-bad/25 bg-bad/10 px-2 py-1 text-bad"
              >
                {f.subscriber}: {f.error}
              </p>
            ))}
          </div>
        )}
        {republish.isError && (
          <p className="mono mt-3 rounded border border-bad/25 bg-bad/10 px-2 py-1 text-[11px] text-bad">
            {republish.error instanceof Error ? republish.error.message : String(republish.error)}
          </p>
        )}
      </Dialog>
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
          className="mono mb-1.5 block text-[10px] uppercase tracking-[0.18em] text-dim"
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
          className="mono h-64 w-full resize-y rounded-lg border border-line bg-sunken/40 p-3 text-[11.5px] leading-relaxed text-fg-2 focus:border-line-strong focus:outline-none"
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
