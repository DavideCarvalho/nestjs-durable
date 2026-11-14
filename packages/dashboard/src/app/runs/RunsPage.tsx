import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react';
import { ActionDialog } from '../../aviary-kit/blocks/action-dialog';
import { EmptyState } from '../../aviary-kit/blocks/empty-state';
import { ErrorBoundary } from '../../aviary-kit/blocks/error-boundary';
import { Toolbar } from '../../aviary-kit/blocks/page-header';
import { ChevronLeftIcon, FilterIcon } from '../../aviary-kit/icons';
import { cn } from '../../aviary-kit/lib/utils';
import { type RunStatus, durableClient } from '../../client/durable-client';
import {
  ALL_ORIGINS,
  type OriginFilter,
  UNKNOWN_ORIGIN,
  emptyRunsNotice,
  matchesOrigin,
  originFacetsFromCounts,
  originFilterKey,
  originLabel,
  unknownCountFromFacets,
} from '../../client/run-origin';
import { stalledWorkflows } from '../../client/summarize-health';
import { AttributeFilters } from '../AttributeFilters';
import { OriginFacets } from '../OriginFacets';
import { LifecyclePendingFilter } from '../RunLifecycle';
import { ValuePicker } from '../ValuePicker';
import { useCapabilities } from '../capabilities';
import { runsFilterKey } from '../run-list-identity';
import { LogoMark, STATUSES, StatusDot } from '../run-status';
import { Button } from '../ui/button';
import { RunDetail } from './RunDetail';
import { RunsList } from './RunsList';
import { anySingleton, useSingletonSiblings } from './singleton';

/**
 * How many runs one page of the list holds. Bounded deliberately: a control plane accumulates runs
 * for as long as its retention policy keeps them (tens of thousands is ordinary), and an unbounded
 * listing costs the browser both the transfer and a DOM node per row. 100 fills the pane several
 * times over; scrolling raises the ceiling for an operator who wants to go further back.
 */
const PAGE_SIZE = 100;

/** Every filter the runs board holds. Lives in the App (not the page) so leaving for Workers and
 *  coming back keeps the operator's narrowing. */
export interface RunFilters {
  status: RunStatus | 'all';
  setStatus: Dispatch<SetStateAction<RunStatus | 'all'>>;
  /** Arrays, not strings: each control takes SEVERAL values, ORed within the axis and ANDed across
   *  them — comparing two tenants, or two tags, is one query rather than two views. */
  tag: string[];
  setTag: Dispatch<SetStateAction<string[]>>;
  /** `key:op:value` predicates (e.g. `amount:gte:200`, `tier:in:pro|enterprise`), ANDed server-side. */
  attr: string[];
  setAttr: Dispatch<SetStateAction<string[]>>;
  /** Empty = EVERY tenant: core keeps read paths namespace-unscoped, so an operator who has always
   *  seen every tenant's runs keeps seeing them until they narrow. */
  namespace: string[];
  setNamespace: Dispatch<SetStateAction<string[]>>;
  /** The one filter that must be able to select ABSENCE (`app`), which an exact match cannot. */
  origin: OriginFilter;
  setOrigin: Dispatch<SetStateAction<OriginFilter>>;
}

export function useRunFilters(): RunFilters {
  const [status, setStatus] = useState<RunStatus | 'all'>('all');
  const [tag, setTag] = useState<string[]>([]);
  const [attr, setAttr] = useState<string[]>([]);
  const [namespace, setNamespace] = useState<string[]>([]);
  const [origin, setOrigin] = useState<OriginFilter>(ALL_ORIGINS);
  return {
    status,
    setStatus,
    tag,
    setTag,
    attr,
    setAttr,
    namespace,
    setNamespace,
    origin,
    setOrigin,
  };
}

/** The status chips, as the Runs page toolbar: counts are the server's, over the whole match set. */
export function StatusToolbar({
  counts,
  value,
  onChange,
}: {
  counts: Record<string, number>;
  value: RunStatus | 'all';
  onChange: (next: RunStatus | 'all') => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (key: RunStatus | 'all', n: number) => (
    <Button
      key={key}
      variant="chip"
      size="chip"
      aria-pressed={value === key}
      onClick={() => onChange(key)}
      className="shrink-0"
    >
      {key !== 'all' && <StatusDot status={key} />}
      <span className="uppercase tracking-wide">{key}</span>
      <span className="mono tnum text-faint">{n}</span>
    </Button>
  );
  return (
    <Toolbar
      label="filter runs by status"
      className="-mx-4 flex-nowrap overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {chip('all', total)}
      {STATUSES.map((s) => chip(s, counts[s] ?? 0))}
    </Toolbar>
  );
}

/**
 * Runs (MONITOR): the board. Container — owns the paged `/runs` query, the server-side facet
 * counts, the bulk actions and the worker-health join; renders the status toolbar, then the
 * filter + list pane and the detail pane. Below `lg` the panes stack: the list, or the open run
 * with a way back.
 */
export function RunsPage({
  filters,
  selected,
  onSelect,
  onOpenRun,
}: {
  filters: RunFilters;
  selected: string | undefined;
  onSelect: (id?: string) => void;
  onOpenRun: (id: string) => void;
}) {
  const can = useCapabilities();
  const {
    status: filter,
    setStatus: setFilter,
    tag: tagFilter,
    setTag: setTagFilter,
    attr: attrFilter,
    setAttr: setAttrFilter,
    namespace: namespaceFilter,
    setNamespace: setNamespaceFilter,
    origin: originFilter,
    setOrigin: setOriginFilter,
  } = filters;
  const [filtersOpen, setFiltersOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024,
  );
  // How many pages of the list are loaded, and for WHICH result set. One piece of state rather than
  // two, so that `pages` can be DERIVED below: reset it from an effect instead and the render that
  // changes the filters still asks for every page the previous view had loaded.
  const [paging, setPaging] = useState({ key: '', pages: 1 });
  const qc = useQueryClient();
  const attrPredicates = attrFilter;
  const attrKey = attrPredicates.join('|');
  // `undefined` = every origin; `null` = the unattributed bucket, which needs its own spelling because
  // no string value matches a run that has no origin. Both go to the SERVER: with a paged list, a
  // facet applied in the browser would filter the page rather than the deployment.
  const originParam =
    originFilter.kind === 'origin'
      ? originFilter.origin
      : originFilter.kind === 'unknown'
        ? null
        : undefined;
  const originKey = originFilterKey(originFilter);
  // Identity for the run list's `key` — every filter that changes which runs the list contains.
  const runsListResetKey = runsFilterKey({
    status: filter,
    tag: tagFilter.join('|'),
    attrs: attrKey,
    namespace: namespaceFilter.join('|'),
    origin: originKey,
  });
  // Every filter change starts at page one.
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
    // Loading more and every filter change move the query key. Without this the list would blank
    // back to its skeleton on each one, which reads as "the runs went away".
    placeholderData: keepPreviousData,
  });
  // The chips' numbers, counted server-side over the WHOLE matching set: the page bounds what is
  // rendered, never what the operator is told exists.
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
  // Each picker's scope EXCLUDES its own axis, or picking a value would collapse the offered list to
  // what is already selected.
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
  // Worker health, joined into each run row (no-worker) and the banner. Shares the `['workers']`
  // cache with the Workers page.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  // A bulk action reaches EVERY server-side match, not just the rows on screen — the dialog states
  // the action and the exact filter before anything runs.
  const [confirmBulk, setConfirmBulk] = useState<'retry' | 'cancel' | undefined>(undefined);
  const bulk = useMutation({
    mutationFn: (action: 'retry' | 'cancel') =>
      durableClient.bulk(action, {
        status: filter !== 'all' ? filter : undefined,
        tag: tagFilter,
        attr: attrPredicates.length ? attrPredicates : undefined,
        namespace: namespaceFilter,
        // Every facet the operator can see, INCLUDING the unattributed bucket — `origin: null` is
        // sent as its own param, so a bulk action is scoped to exactly the set the list was showing.
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
  // Counted over EVERY origin — to be able to say "these N runs cannot be matched by any package
  // filter" at the moment a package filter shows nothing.
  const unattributed = useMemo(() => unknownCountFromFacets(facets), [facets]);
  // How many runs the current filters match in total, so the list can say what it is NOT showing.
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
  const activeFilterCount =
    tagFilter.length +
    namespaceFilter.length +
    attrPredicates.length +
    (originFilter.kind !== 'all' ? 1 : 0);
  const originChips = useMemo(() => originFacetsFromCounts(facets), [facets]);
  // Workflows whose queue has backlog and no worker consuming it — a banner, so it's obvious
  // nothing will progress until a worker rejoins.
  const stalled = useMemo(() => stalledWorkflows(health), [health]);
  const singletonSiblings = useSingletonSiblings(useMemo(() => anySingleton(runs), [runs]));

  // A chip on a run row ADDS its value to the picker rather than replacing the selection.
  const addTag = useCallback(
    (tag: string) =>
      setTagFilter((current) => (current.includes(tag) ? current : [...current, tag])),
    [setTagFilter],
  );
  const addNamespace = useCallback(
    (namespace: string) =>
      setNamespaceFilter((current) =>
        current.includes(namespace) ? current : [...current, namespace],
      ),
    [setNamespaceFilter],
  );
  const loadMore = useCallback(() => {
    setPaging((p) => ({
      key: runsListResetKey,
      pages: p.key === runsListResetKey ? p.pages + 1 : 2,
    }));
  }, [runsListResetKey]);

  const filterSummary =
    [
      filter !== 'all' ? `status ${filter}` : undefined,
      tagFilter.length > 0 ? `tag ${tagFilter.join(', ')}` : undefined,
      namespaceFilter.length > 0 ? `tenant ${namespaceFilter.join(', ')}` : undefined,
      attrPredicates.length > 0 ? `attr ${attrPredicates.join(' · ')}` : undefined,
      originFilter.kind === 'origin' ? `origin ${originLabel(originFilter.origin)}` : undefined,
      originFilter.kind === 'unknown' ? `origin ${UNKNOWN_ORIGIN}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(' · ') || 'no filter — every run';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stalled.length > 0 && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-[12px] text-warn md:px-6">
          <span className="dot s-no-worker shrink-0" aria-hidden />
          <span>
            Runs waiting on handlers with no live worker:{' '}
            <span className="mono font-medium">{stalled.join(', ')}</span>. Start a worker to
            unblock.
          </span>
        </div>
      )}
      <div
        className={cn(
          'flex flex-col gap-3 px-4 pt-5 pb-3 md:px-6 md:pt-6',
          selected !== undefined && 'hidden lg:flex',
        )}
      >
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold tracking-[0.01em] text-fg">Runs</h1>
            <p className="mt-1 text-xs text-faint">
              {facets.length > 0 || !runsPending
                ? `${matchedTotal} ${anyFilter ? 'matching ' : ''}run${matchedTotal === 1 ? '' : 's'} · live`
                : 'Every workflow run, live.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={filtersOpen}
            aria-controls="runs-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <FilterIcon />
            Filters
            {activeFilterCount > 0 && (
              <span className="mono tnum rounded bg-primary/15 px-1 text-[10px] text-brand">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>
        <StatusToolbar counts={counts} value={filter} onChange={setFilter} />
      </div>
      <div className="min-h-0 flex-1 px-0 pb-0 md:px-6 md:pb-6">
        <div className="aviary-surface grid h-full min-h-0 overflow-hidden border-t border-border bg-card md:rounded-lg md:border lg:grid-cols-[minmax(300px,380px)_1fr]">
          <aside
            aria-label="Runs"
            className={cn(
              'flex min-h-0 flex-col border-border lg:border-r',
              selected !== undefined && 'hidden lg:flex',
            )}
          >
            <ErrorBoundary label="Filters">
              {filtersOpen && (
                <div id="runs-filters" className="border-b border-border p-2">
                  <ValuePicker
                    field="tag"
                    scope={tagScope}
                    glyph="#"
                    label="filter by tag"
                    placeholder="filter by tag…"
                    value={tagFilter}
                    onChange={setTagFilter}
                    title="Tags carried by a run (WorkflowRun.tags). Several match ANY of them."
                  />
                  {can('tags') && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <LifecyclePendingFilter tags={tagFilter} onChange={setTagFilter} />
                    </div>
                  )}
                  <div className={can('namespaces') ? 'mt-1.5' : 'hidden'}>
                    <ValuePicker
                      field="namespace"
                      scope={namespaceScope}
                      glyph="@"
                      label="filter by tenant"
                      placeholder="filter by tenant / namespace…"
                      value={namespaceFilter}
                      onChange={setNamespaceFilter}
                      title="Tenant / worker-pool partition (WorkflowRun.namespace). None selected shows every tenant."
                    />
                  </div>
                  {can('searchAttributes') && (
                    <AttributeFilters
                      value={attrFilter}
                      onChange={setAttrFilter}
                      scope={attrScope}
                    />
                  )}
                </div>
              )}
              {can('origins') && (
                <OriginFacets
                  facets={originChips}
                  value={originFilter}
                  onChange={setOriginFilter}
                />
              )}
            </ErrorBoundary>
            {anyFilter && matchedTotal > 0 && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="mono min-w-0 truncate text-[10px] text-dim">
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
                  onClick={() => setConfirmBulk('retry')}
                  className="mono ml-auto"
                >
                  retry all
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  disabled={bulk.isPending}
                  onClick={() => setConfirmBulk('cancel')}
                  className="mono"
                >
                  cancel all
                </Button>
              </div>
            )}
            {/* RunsList's virtualized root owns its scroll container; this only sizes the box. */}
            <div className="min-h-0 flex-1">
              <ErrorBoundary label="Run list" resetKeys={[runsListResetKey]}>
                <RunsList
                  // Remounts on any filter change: the simplest way to reset BOTH the virtualiser's
                  // scroll position and its row-height cache.
                  key={runsListResetKey}
                  runs={runs}
                  siblings={singletonSiblings}
                  health={health}
                  loading={runsPending}
                  selected={selected}
                  onSelect={onSelect}
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
              </ErrorBoundary>
            </div>
          </aside>
          <section
            aria-label="Run detail"
            className={cn('min-h-0 min-w-0', selected === undefined && 'hidden lg:block')}
          >
            {selected ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-border px-3 py-2 lg:hidden">
                  <Button variant="ghost" size="sm" onClick={() => onSelect(undefined)}>
                    <ChevronLeftIcon />
                    All runs
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  <ErrorBoundary label="Run detail" resetKeys={[selected]}>
                    <RunDetail key={selected} id={selected} onOpenRun={onOpenRun} />
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <EmptyState
                className="h-full"
                icon={<LogoMark className="size-6" />}
                title="No run selected"
                description="Select a run to see its timeline, steps and spans."
              />
            )}
          </section>
        </div>
      </div>
      <ActionDialog
        open={confirmBulk !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(undefined);
        }}
        title={confirmBulk === 'cancel' ? 'Cancel all matching runs' : 'Retry all matching runs'}
        description={filterSummary}
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setConfirmBulk(undefined)}>
              Back
            </Button>
            <Button
              size="sm"
              variant={confirmBulk === 'cancel' ? 'danger' : 'brand'}
              disabled={bulk.isPending}
              onClick={() => {
                if (confirmBulk) bulk.mutate(confirmBulk);
                setConfirmBulk(undefined);
              }}
            >
              {confirmBulk === 'cancel' ? 'cancel all' : 'retry all'}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          This {confirmBulk === 'cancel' ? 'cancels' : 'retries'} <em>every</em> run matching the
          filter above on the server — <span className="mono tnum text-fg">{matchedTotal}</span> run
          {matchedTotal === 1 ? '' : 's'}, including the ones not loaded on screen.
        </p>
      </ActionDialog>
      {bulk.error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-bad/40 bg-bad/15 px-4 py-2 text-[12px] text-bad"
        >
          Bulk action failed:{' '}
          {bulk.error instanceof Error ? bulk.error.message : String(bulk.error)}
        </div>
      )}
    </div>
  );
}
