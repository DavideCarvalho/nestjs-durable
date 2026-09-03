import { useMemo, useState } from 'react';
import { CheckIcon, XIcon } from '../icons';
import { Badge } from './badge';
import { Button } from './button';
import { cn } from './cn';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/** One offered value and how many matching runs carry it — what the server counted for this field. */
export interface MultiSelectOption {
  value: string;
  count: number;
}

export interface MultiSelectProps {
  /** Leading glyph, matching the console's filter rows (`#`, `@`, `⛃`). Decorative. */
  glyph?: React.ReactNode;
  label: string;
  placeholder: string;
  value: string[];
  onChange: (next: string[]) => void;
  options: MultiSelectOption[];
  /** Options are still being fetched — distinguishes "nothing matches" from "nothing yet". */
  loading?: boolean;
  /**
   * The options could not be fetched. Says so, rather than rendering the empty list that a failed
   * request would otherwise be indistinguishable from — the same silence that let a broken filter
   * wire look like a console with nothing to offer.
   */
  failed?: boolean;
  /**
   * Whether a value the list does not offer can be typed in. On by default, and it matters: the
   * offered list is a bounded top-N over a bounded scan, so a rare value can be real and absent.
   * Without this, a picker would be a smaller filter than the text box it replaced.
   */
  allowCustom?: boolean;
  title?: string;
}

/**
 * A filter control that lists what the data actually contains, and takes several of them.
 *
 * The console's filters used to be free-text boxes: an operator had to already know a tenant name or
 * a tag to use one, and a typo returned an empty list indistinguishable from "no runs match". The
 * options here are counted server-side over the runs the OTHER filters already select, so every
 * offered value returns something, and the counts say how much.
 *
 * Typed text filters the list AND stands as a custom value (Enter adds it), because the offered list
 * is deliberately bounded — see `allowCustom`.
 */
export function MultiSelect({
  glyph,
  label,
  placeholder,
  value,
  onChange,
  options,
  loading,
  failed,
  allowCustom = true,
  title,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = term ? options.filter((o) => o.value.toLowerCase().includes(term)) : options;
    // Selected values stay visible even when the current scope no longer offers them — otherwise
    // narrowing by one filter makes another's selection unremovable from the popover.
    const missing = value
      .filter((v) => !matching.some((o) => o.value === v))
      .filter((v) => !term || v.toLowerCase().includes(term))
      .map((v) => ({ value: v, count: 0 }));
    return [...missing, ...matching];
  }, [options, search, value]);

  const toggle = (next: string): void => {
    onChange(value.includes(next) ? value.filter((v) => v !== next) : [...value, next]);
  };

  const custom = search.trim();
  const canAddCustom =
    allowCustom &&
    custom !== '' &&
    !shown.some((o) => o.value === custom) &&
    !value.includes(custom);

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 transition-colors focus-within:border-zinc-600">
      {glyph !== undefined && (
        <span className="shrink-0 text-zinc-600" aria-hidden>
          {glyph}
        </span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={label}
              title={title ?? label}
              className="mono flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5 text-left text-xs text-zinc-200 focus:outline-none"
            />
          }
        >
          {value.length === 0 ? (
            <span className="text-zinc-600">{placeholder}</span>
          ) : (
            value.map((v) => (
              <Badge key={v} className="mono max-w-[10rem] truncate">
                {v}
              </Badge>
            ))
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="border-b border-line px-2">
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={allowCustom ? 'search, or type a value…' : 'search…'}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !canAddCustom) return;
                e.preventDefault();
                toggle(custom);
                setSearch('');
              }}
            />
          </div>
          {/* A listbox rather than a stack of buttons: several values can be on at once, which is
              what `aria-multiselectable` + per-row `aria-selected` say and a button cannot. */}
          <div
            className="max-h-64 overflow-auto py-1"
            // biome-ignore lint/a11y/useSemanticElements: a native <select multiple> cannot carry a
            // per-value count, the search box, or the "use as typed" row this control is built
            // around; the listbox/option roles describe the same semantics without them.
            role="listbox"
            tabIndex={-1}
            aria-multiselectable
            aria-label={label}
          >
            {canAddCustom && (
              <button
                type="button"
                aria-label={`use ${custom} as typed`}
                onClick={() => {
                  toggle(custom);
                  setSearch('');
                }}
                className="mono flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <span className="w-3 shrink-0 text-zinc-600">+</span>
                <span className="truncate">{custom}</span>
                <span className="ml-auto text-[10px] text-zinc-600">use as typed</span>
              </button>
            )}
            {shown.length === 0 && !canAddCustom && (
              <p
                className={cn('px-2 py-2 text-[11px]', failed ? 'text-rose-300' : 'text-zinc-600')}
              >
                {failed
                  ? "couldn't load values — type one instead"
                  : loading
                    ? 'loading…'
                    : 'no values here'}
              </p>
            )}
            {shown.map((option) => {
              const selected = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold the count
                  // column, and this row is a toggle rather than a single-choice selection.
                  role="option"
                  aria-selected={selected}
                  onClick={() => toggle(option.value)}
                  className={cn(
                    'mono flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-zinc-800',
                    selected ? 'text-zinc-100' : 'text-zinc-400',
                  )}
                >
                  <span className="w-3 shrink-0">
                    {selected && <CheckIcon width={12} height={12} />}
                  </span>
                  <span className="truncate">{option.value}</span>
                  {/* A count of 0 means "selected, but outside the current scope" — no runs to show. */}
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{option.count}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onChange([])}
          title={`clear ${label}`}
          aria-label={`clear ${label}`}
          className="h-4 w-4"
        >
          <XIcon width={12} height={12} />
        </Button>
      )}
    </div>
  );
}
