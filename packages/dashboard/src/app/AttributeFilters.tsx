import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type RunPredicates, durableClient } from '../client/durable-client';
import { XIcon } from './icons';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { MultiSelect } from './ui/multi-select';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/** The operators a search-attribute predicate can carry, in the words an operator reads them in. */
const OPERATORS = [
  { op: 'eq', label: 'is' },
  { op: 'in', label: 'is any of' },
  { op: 'ne', label: 'is not' },
  { op: 'gte', label: '≥' },
  { op: 'gt', label: '>' },
  { op: 'lte', label: '≤' },
  { op: 'lt', label: '<' },
] as const;

type Op = (typeof OPERATORS)[number]['op'];

/** `key:op:value` (or `key:in:a|b`) — the wire spelling — split for display. Returns null for an
 *  entry that is not one, which the console renders verbatim rather than dropping. */
function parse(predicate: string): { key: string; op: string; operand: string } | null {
  const [key, op, ...rest] = predicate.split(':');
  if (!key || !op || rest.length === 0) return null;
  return { key, op, operand: rest.join(':') };
}

function label(predicate: string): string {
  const parsed = parse(predicate);
  if (!parsed) return predicate;
  const op = OPERATORS.find((o) => o.op === parsed.op)?.label ?? parsed.op;
  return `${parsed.key} ${op} ${parsed.operand.split('|').join(', ')}`;
}

export interface AttributeFiltersProps {
  /** `key:op:value` predicates, ANDed — the same list the client sends as `attr`. */
  value: string[];
  onChange: (next: string[]) => void;
  /** The rest of the active filter, so the keys and values offered are the ones these runs carry. */
  scope: RunPredicates;
}

/**
 * The search-attribute filter, as a builder over what the runs actually carry.
 *
 * Typed attributes are the one filter an operator cannot guess: the keys are whatever the workflow
 * author passed to `ctx.setSearchAttributes`, and the values are data. Typing `key:op:value` blind
 * meant knowing both up front, and a typo in either returned an empty list that reads exactly like
 * "no runs match". Both sides are enumerated from the server here, scoped by the rest of the filter.
 *
 * `is any of` exists because two `is` predicates on one key are ANDed like every other pair, and no
 * run has one attribute with two values — so without a set operator, picking a second value would
 * always return nothing.
 */
export function AttributeFilters({ value, onChange, scope }: AttributeFiltersProps) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [op, setOp] = useState<Op>('eq');
  const [operands, setOperands] = useState<string[]>([]);
  const [text, setText] = useState('');

  const { data: keys = [] } = useQuery({
    queryKey: ['run-values', 'attr', scope],
    queryFn: () => durableClient.values('attr', scope),
    enabled: open,
    staleTime: 5000,
  });
  const { data: values = [] } = useQuery({
    queryKey: ['run-values', `attr.${key}`, scope],
    queryFn: () => durableClient.values(`attr.${key}`, scope),
    enabled: open && key !== '',
    staleTime: 5000,
  });

  const keyOptions = useMemo(
    () =>
      keys
        .filter((row) => row.value !== null)
        .map((row) => ({ value: row.value as string, count: row.count })),
    [keys],
  );
  const valueOptions = useMemo(
    () =>
      values
        .filter((row) => row.value !== null)
        .map((row) => ({ value: row.value as string, count: row.count })),
    [values],
  );

  // Range operators compare against ONE operand and are usually numeric, so they take free text;
  // equality and set membership pick from what exists.
  const picksFromList = op === 'eq' || op === 'in';
  const operand = picksFromList ? operands.join('|') : text.trim();
  const canAdd = key !== '' && operand !== '';

  const reset = (): void => {
    setKey('');
    setOp('eq');
    setOperands([]);
    setText('');
  };

  const add = (): void => {
    if (!canAdd) return;
    // A single value under `is any of` is just `is` — keep the wire minimal so the predicate reads
    // the same way it was built.
    const wireOp = op === 'in' && operands.length === 1 ? 'eq' : op;
    onChange([...value, `${key}:${wireOp}:${operand}`]);
    reset();
    setOpen(false);
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {value.map((predicate) => (
        <Badge key={predicate} variant="attr" className="mono gap-1 py-0.5">
          {label(predicate)}
          <Button
            variant="ghost"
            size="icon"
            className="h-3 w-3 text-indigo-300/70 hover:text-indigo-100"
            title={`remove ${label(predicate)}`}
            aria-label={`remove ${label(predicate)}`}
            onClick={() => onChange(value.filter((p) => p !== predicate))}
          >
            <XIcon width={10} height={10} />
          </Button>
        </Badge>
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="add a search-attribute filter"
              title="Typed search attributes (WorkflowRun.searchAttributes)"
              className="mono rounded border border-dashed border-line px-1.5 py-0.5 text-[10px] text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
            />
          }
        >
          ⛃ attribute
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <div className="flex flex-col gap-1.5">
            <MultiSelect
              glyph="⛃"
              label="attribute key"
              placeholder="key…"
              options={keyOptions}
              value={key ? [key] : []}
              onChange={(next) => {
                // Single-select: the last click wins, and changing the key drops operands chosen
                // for the previous one (they belong to a different value domain).
                setKey(next.at(-1) ?? '');
                setOperands([]);
              }}
            />
            <select
              aria-label="operator"
              value={op}
              onChange={(e) => setOp(e.target.value as Op)}
              className="mono rounded-md border border-line bg-transparent px-2 py-1.5 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
            >
              {OPERATORS.map((entry) => (
                <option key={entry.op} value={entry.op} className="bg-zinc-900">
                  {entry.label}
                </option>
              ))}
            </select>
            {picksFromList ? (
              <MultiSelect
                glyph="="
                label="attribute value"
                placeholder={key ? 'value…' : 'pick a key first'}
                options={key ? valueOptions : []}
                value={operands}
                onChange={(next) => setOperands(op === 'in' ? next : next.slice(-1))}
              />
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-zinc-600">
                <span className="shrink-0 text-zinc-600" aria-hidden>
                  =
                </span>
                <Input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="value…"
                  aria-label="attribute value"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') add();
                  }}
                />
              </div>
            )}
            <Button
              variant="brand"
              size="chip"
              className="mono self-end rounded"
              disabled={!canAdd}
              onClick={add}
            >
              add filter
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
