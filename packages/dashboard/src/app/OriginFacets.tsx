import type { OriginFacet, OriginFilter } from '../client/run-origin';
import { originFilterKey, sameOriginFilter } from '../client/run-origin';
import { Button } from './ui/button';
import { cn } from './ui/cn';

/**
 * The "which library produced this run" facet: one chip per origin, with its count, plus `all` and
 * (when there are any) `unknown`.
 *
 * Built like the header's STATUS chips rather than the sidebar's tag box, for two reasons that both
 * come from `WorkflowRun.origin` being a small, closed, machine-derived set: every value and its
 * count stays visible without a click, and — crucially — the unattributed bucket keeps its count on
 * screen even while a package is selected.
 *
 * The chips are handed in already counted (`originFacetsFromCounts` over the server's `runs/facets`
 * aggregate) rather than counted here over a run list, because the list this sits above is a PAGE:
 * counting the rows on screen would make every chip report the page size. The server can express the
 * unattributed bucket too (`origin IS NULL`), so selecting a chip narrows the query rather than
 * filtering what was already fetched.
 *
 * Renders nothing when there is nothing to choose between (no runs, so only `all`).
 */
export function OriginFacets({
  facets,
  value,
  onChange,
}: {
  facets: readonly OriginFacet[];
  value: OriginFilter;
  onChange: (filter: OriginFilter) => void;
}) {
  if (facets.length <= 1) return null;
  return (
    // A plain container with a visible caption, exactly like the header's status chip row — the
    // caption is the label, so there is no `role="group"` for `useSemanticElements` to object to.
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
      <span className="mono shrink-0 text-[10px] uppercase tracking-[0.18em] text-zinc-600">
        origin
      </span>
      {facets.map((facet) => {
        const selected = sameOriginFilter(value, facet.filter);
        return (
          <Button
            key={originFilterKey(facet.filter)}
            variant="ghost"
            size="chip"
            aria-pressed={selected}
            title={facet.title}
            onClick={() => onChange(facet.filter)}
            className={cn(
              'mono max-w-full gap-1 rounded-md',
              // An unattributed run is not a package, so its chip is not styled like one — dim and
              // italic says "absence" without hiding it or dressing it up as a real origin.
              facet.filter.kind === 'unknown' && 'italic text-zinc-500',
              selected && 'border-zinc-600 bg-zinc-900 text-zinc-100 hover:text-zinc-100',
            )}
          >
            <span className="truncate">{facet.label}</span>
            <span className="tnum shrink-0 text-zinc-600">{facet.count}</span>
          </Button>
        );
      })}
    </div>
  );
}
