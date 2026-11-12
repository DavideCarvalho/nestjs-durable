import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { ConsoleIcon, type ConsoleIconKey, iconKey } from './console-switcher-icons';

/** One hit of the global search. */
export interface SearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

/** One console's hits. */
export interface SearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: SearchHit[];
}

/** What the search endpoint answered, sanitized. */
export interface SearchAnswer {
  groups: SearchGroup[];
  partial: boolean;
}

const safeHref = (href: unknown): href is string =>
  typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');

/** The usable part of a `GET <api>/consoles/search` answer: unsafe links and bad entries dropped. */
export function sanitizeSearch(value: unknown): SearchAnswer {
  const body = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const results = Array.isArray(body.results) ? body.results : [];
  const groups = results.flatMap((item: unknown): SearchGroup[] => {
    if (typeof item !== 'object' || item === null) return [];
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits))
      return [];
    const hits = g.hits.flatMap((raw: unknown): SearchHit[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const h = raw as Record<string, unknown>;
      if (typeof h.title !== 'string' || !safeHref(h.href)) return [];
      return [
        {
          title: h.title,
          ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
          href: h.href,
        },
      ];
    });
    return hits.length > 0 ? [{ id: g.id, title: g.title, icon: iconKey(g.icon), hits }] : [];
  });
  return { groups, partial: body.partial === true };
}

/** Ask the search endpoint. Any failure reads as "no hits". */
export async function searchConsoles(
  endpoint: string,
  q: string,
  signal?: AbortSignal,
): Promise<SearchAnswer> {
  try {
    const res = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    return res.ok ? sanitizeSearch(await res.json()) : { groups: [], partial: false };
  } catch {
    return { groups: [], partial: false };
  }
}

/** Whether a key event is the palette shortcut: Ctrl-K, or Cmd-K on a Mac. */
export function isSearchShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  return event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey);
}

/**
 * The global search palette: one box that searches every console the viewer may open, hits grouped
 * per console. Arrow keys move, Enter opens, Escape closes.
 */
export function ConsoleSearch({
  endpoint,
  onClose,
  navigate = (href) => window.location.assign(href),
}: {
  endpoint: string;
  onClose: () => void;
  navigate?: (href: string) => void;
}) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer>({ groups: [], partial: false });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query === '') {
      setAnswer({ groups: [], partial: false });
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void searchConsoles(endpoint, query, controller.signal).then((next) => {
        if (controller.signal.aborted) return;
        setAnswer(next);
        setActive(0);
        setLoading(false);
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, endpoint]);

  const flat = answer.groups.flatMap((group) => group.hits);
  const open = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    navigate(hit.href);
  };

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' && flat.length > 0) {
      event.preventDefault();
      setActive((at) => (at + 1) % flat.length);
    } else if (event.key === 'ArrowUp' && flat.length > 0) {
      event.preventDefault();
      setActive((at) => (at - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(flat[active]);
    }
  };

  let index = -1;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        aria-modal="true"
        aria-label="Search all consoles"
        className="static m-0 w-full max-w-xl overflow-hidden rounded-lg border border-line bg-popover p-0 text-foreground shadow-lg shadow-black/50"
        onKeyDown={onKey}
        data-aviary-search=""
      >
        <input
          ref={input}
          type="search"
          aria-label="Search all consoles"
          aria-describedby="aviary-search-results"
          placeholder="Search runs, workflows and the other consoles…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div
          id="aviary-search-results"
          aria-live="polite"
          className="max-h-[60vh] overflow-y-auto p-1"
        >
          {answer.groups.map((group) => (
            <section key={group.id} aria-label={group.title} className="py-1">
              <h3 className="flex items-center gap-2 px-3 py-1 text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
                <ConsoleIcon icon={group.icon} />
                {group.title}
              </h3>
              <ul>
                {group.hits.map((hit) => {
                  index += 1;
                  const at = index;
                  return (
                    <li key={`${group.id}:${hit.href}`}>
                      <a
                        href={hit.href}
                        aria-current={at === active ? 'true' : undefined}
                        data-active={at === active ? '' : undefined}
                        onMouseEnter={() => setActive(at)}
                        onClick={(event) => {
                          event.preventDefault();
                          open(hit);
                        }}
                        className={`block rounded-md px-3 py-1.5 text-sm ${
                          at === active ? 'bg-panel text-foreground' : 'text-foreground'
                        }`}
                      >
                        <div className="truncate">{hit.title}</div>
                        {hit.subtitle && (
                          <div className="truncate text-xs text-muted-foreground">
                            {hit.subtitle}
                          </div>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {q.trim() !== '' && !loading && flat.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">No results.</p>
          )}
          {answer.partial && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Some consoles didn’t answer in time; their results may be missing.
            </p>
          )}
        </div>
      </dialog>
    </div>
  );
}
