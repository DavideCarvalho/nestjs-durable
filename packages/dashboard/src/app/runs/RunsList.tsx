import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useRef } from 'react';
import { EmptyState } from '../../aviary-kit/blocks/empty-state';
import { Skeleton } from '../../aviary-kit/ui/skeleton';
import { type GroupHealth, type WorkflowRun, deriveRunState } from '../../client/durable-client';
import {
  type OriginFilter,
  UNKNOWN_ORIGIN_TITLE,
  type emptyRunsNotice,
  knownOrigin,
  originLabel,
} from '../../client/run-origin';
import { shouldLoadMore } from '../load-more';
import { runRowKey } from '../run-list-identity';
import { StatusBadge as Badge, LogoMark, relTime } from '../run-status';
import { Badge as Chip, badgeVariants } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';

/** Placeholder rows shown while the first `/runs` fetch is in flight, so the pane never flashes
 *  "No runs yet." before real data lands. Same row footprint as a real run → no layout jump. */
export function RunsListSkeleton() {
  return (
    <ul className="divide-y divide-line-soft" aria-hidden data-runs-skeleton="">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-2.5 w-48" />
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
        selected ? 'bg-brand-soft shadow-[inset_2px_0_0_var(--aviary-accent)]' : 'hover:bg-hover'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{run.workflow}</span>
          {tenant && (
            <Chip
              variant="tenant"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-info/60 hover:text-info"
              title={`Tenant / worker-pool partition — click to show only ${tenant}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNamespace(tenant);
              }}
            >
              {tenant}
            </Chip>
          )}
          {/* Origin, when the run HAS one. An app-own run shows no chip here rather than
              a row of `app` noise — the facet above keeps its count on screen, the empty
              state names it, and the run's own detail header states it outright. */}
          {origin && (
            <Chip
              variant="origin"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-teal/60 hover:text-teal"
              title={`Declared by ${origin} — click to show only this library's runs`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectOrigin({ kind: 'origin', origin });
              }}
            >
              {originLabel(origin)}
            </Chip>
          )}
          {run.tenantId && (
            <Chip
              variant="organization"
              className="shrink-0 px-1 text-[9px]"
              title={`Organization (customer tenant): ${run.tenantLabel ?? run.tenantId}${
                run.tenantKind ? ` · ${run.tenantKind}` : ''
              } · ${run.tenantId}`}
            >
              {run.tenantLabel ?? run.tenantId}
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
        <span className="mono truncate text-[11px] text-faint">{run.id}</span>
        <span className="shrink-0 text-[11px] text-faint">{relTime(run.updatedAt)}</span>
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
                'mono cursor-pointer hover:border-line-strong hover:text-fg',
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

export function RunsList({
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
      <EmptyState
        icon={<LogoMark className="size-5" />}
        title={emptyNotice.message}
        description={
          emptyNotice.unclassified !== undefined
            ? `${emptyNotice.unclassified} run${emptyNotice.unclassified === 1 ? '' : 's'} here ${
                emptyNotice.unclassified === 1 ? 'is' : 'are'
              } the app's own (no package origin), so no package filter can match ${
                emptyNotice.unclassified === 1 ? 'it' : 'them'
              }.`
            : undefined
        }
        action={
          emptyNotice.unclassified !== undefined ? (
            <Button
              variant="chip"
              size="xs"
              className="mono"
              title={UNKNOWN_ORIGIN_TITLE}
              onClick={() => onSelectOrigin({ kind: 'unknown' })}
            >
              show app runs
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-auto">
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
        <span className="mono text-[10px] text-faint">
          {runs.length} of {total}
        </span>
        {more && (
          <span className="mono ml-auto text-[10px] text-faint">
            {loadingMore ? 'loading…' : 'scroll for more'}
          </span>
        )}
      </div>
    </div>
  );
}
