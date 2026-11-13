import {
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Query,
  createParamDecorator,
} from '@nestjs/common';
import { CONSOLE_AUTHORIZE_DECIDE, type ConsoleDecide } from './console-authorize.js';
import { DashboardService } from './dashboard.service.js';
import { DASHBOARD_BASE_PATH } from './tokens.js';

// ── the console registry (v1), re-declared: no Aviary console imports another ──────────────

/** The process-wide slot every Aviary console registers into (created by whichever boots first). */
export const AVIARY_CONSOLES_SLOT: symbol = Symbol.for('@dudousxd/aviary:consoles');

/** The icon a console shows in the switcher. An unknown value renders as `generic`. */
export type AviaryConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

/** What a console's `authorize` answers; only `allowed: true` lists it. */
export interface AviaryConsoleDecision {
  allowed: boolean;
  reason?: string;
  redirectTo?: string;
}

/** One hit of a console's global search. */
export interface AviaryConsoleSearchHit {
  title: string;
  subtitle?: string;
  /** Same-origin absolute path (`/durable#/run/42`). */
  href: string;
}

/** One console the switcher can list. */
export interface AviaryConsoleEntry {
  /** `/^[a-z][a-z0-9-]*$/`: `'durable'`, `'telescope'`, `'agent'`, `'media'`, … */
  id: string;
  /** Product title: `'Workflows'`, `'Telescope'`, `'Agents'`, `'Media'`. */
  title: string;
  icon: AviaryConsoleIcon;
  /** Same-origin absolute path of the console's page (`/durable`). */
  path: string;
  /** Sort key: durable 10, telescope 20, agent 30, media 50. */
  order: number;
  /** The console's resolved gate (what its own routes run). Never throws. */
  authorize(context: ExecutionContext): Promise<AviaryConsoleDecision>;
  /**
   * Global search over this console's data, for a viewer this console already allowed: at most
   * `limit` hits, each a same-origin link into the console.
   */
  search?(context: ExecutionContext, q: string, limit: number): Promise<AviaryConsoleSearchHit[]>;
}

/** The value at {@link AVIARY_CONSOLES_SLOT}. Data only, so every console's copy is identical. */
export interface AviaryConsoleRegistry {
  readonly version: 1;
  readonly entries: AviaryConsoleEntry[];
}

/** One console as `GET <api>/consoles` returns it. */
export interface VisibleConsole {
  id: string;
  title: string;
  icon: AviaryConsoleIcon;
  href: string;
}

/** The answer of `GET <api>/consoles`. */
export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: VisibleConsole[];
}

/** The answer of `GET <api>/consoles/search?q=`. */
export interface ConsoleSearchResults {
  version: 1;
  q: string;
  /**
   * `true` when a console could not answer in time (its `authorize` or `search` timed out or
   * failed): the results may be missing its hits.
   */
  partial: boolean;
  results: Array<{
    id: string;
    title: string;
    icon: AviaryConsoleIcon;
    hits: AviaryConsoleSearchHit[];
  }>;
}

/** The `switcher` field of the shell's config block. */
export interface ConsoleSwitcherConfig {
  endpoint: string;
  others: number;
}

const ID = /^[a-z][a-z0-9-]*$/;
const ICONS = new Set<string>([
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
]);

/** How long another console's `authorize` (or `search`) may take before it is left out. */
export const CONSOLE_PROBE_TIMEOUT_MS: number = 300;

/** Hits per console in a global search. */
export const CONSOLE_SEARCH_HITS: number = 5;

/** Whether `path` is a same-origin absolute path (`/x`; never `//host` or a URL). */
export function isSameOriginPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

/** The registry, when one is set with a version this copy reads. */
export function readAviaryConsoles(): AviaryConsoleRegistry | undefined {
  const value = (globalThis as Record<symbol, unknown>)[AVIARY_CONSOLES_SLOT] as
    | Partial<AviaryConsoleRegistry>
    | undefined;
  if (value?.version !== 1 || !Array.isArray(value.entries)) return undefined;
  return value as AviaryConsoleRegistry;
}

/**
 * Adds a console to the process's switcher registry, creating it when absent. Returns a function
 * that removes the entry again, or `undefined` when it was not added (another registry version, or
 * the id is taken: logged as a warning). A bad `id` or `path` throws.
 */
export function registerAviaryConsole(
  entry: AviaryConsoleEntry,
  logger?: { warn(message: string): void },
): (() => void) | undefined {
  if (!ID.test(entry.id)) throw new Error(`console id ${JSON.stringify(entry.id)} is invalid`);
  if (!isSameOriginPath(entry.path)) {
    throw new Error(`console path ${JSON.stringify(entry.path)} must start with a single "/"`);
  }
  const holder = globalThis as Record<symbol, unknown>;
  if (holder[AVIARY_CONSOLES_SLOT] === undefined) {
    const fresh: AviaryConsoleRegistry = { version: 1, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = fresh;
  }
  const registry = readAviaryConsoles();
  if (registry === undefined) return undefined;
  if (registry.entries.some((existing) => existing.id === entry.id)) {
    logger?.warn(`console id "${entry.id}" is already registered`);
    return undefined;
  }
  registry.entries.push(entry);
  return () => {
    const index = registry.entries.indexOf(entry);
    if (index !== -1) registry.entries.splice(index, 1);
  };
}

/** The shell's `switcher` config: only when another console is registered (no `authorize` runs). */
export function consoleSwitcherConfig(
  selfId: string,
  endpoint: string,
): ConsoleSwitcherConfig | undefined {
  const registry = readAviaryConsoles();
  if (!registry?.entries.some((entry) => entry.id === selfId)) return undefined;
  const others = registry.entries.filter((entry) => entry.id !== selfId).length;
  return others > 0 ? { endpoint, others } : undefined;
}

/** `fn`'s value within `ms`, or `{ ok: false }` on a timeout or a rejection. */
async function within<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(fn)
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `fn` with the probe marker on the request: an `authorize` (or `search`) that writes an audit
 * trail can read `request.aviaryProbe === true` and skip it, since the switcher only asks, it does
 * not open anything. The marker is removed (or restored) once `fn` settles.
 */
async function probing<T>(context: ExecutionContext, fn: () => Promise<T>): Promise<T> {
  const http = typeof context?.getType === 'function' && context.getType() === 'http';
  const request = http
    ? (context.switchToHttp().getRequest() as { aviaryProbe?: boolean | undefined } | undefined)
    : undefined;
  if (!request || typeof request !== 'object') return fn();
  const had = Object.hasOwn(request, 'aviaryProbe');
  const previous = request.aviaryProbe;
  request.aviaryProbe = true;
  try {
    return await fn();
  } finally {
    if (had) request.aviaryProbe = previous;
    else Reflect.deleteProperty(request, 'aviaryProbe');
  }
}

function sorted(entries: readonly AviaryConsoleEntry[]): AviaryConsoleEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The entries whose `authorize` allows the viewer, and whether any of them could not answer. */
async function allowedEntries(
  entries: AviaryConsoleEntry[],
  context: ExecutionContext,
  ms: number,
): Promise<{ allowed: AviaryConsoleEntry[]; unanswered: boolean }> {
  const verdicts = await probing(context, () =>
    Promise.all(
      entries.map((entry) =>
        within(async () => (await entry.authorize(context))?.allowed === true, ms),
      ),
    ),
  );
  return {
    allowed: entries.filter((_, index) => {
      const verdict = verdicts[index];
      return verdict?.ok === true && verdict.value;
    }),
    unanswered: verdicts.some((verdict) => !verdict.ok),
  };
}

function iconOf(icon: unknown): AviaryConsoleIcon {
  return ICONS.has(icon as string) ? (icon as AviaryConsoleIcon) : 'generic';
}

/**
 * The consoles other than `selfId` the viewer may open, by `order` then `id`. Every other entry's
 * `authorize` runs in parallel, each given `timeoutMs`; a timeout, a rejection or any denial hides
 * it. No reason is ever returned.
 */
export async function listVisibleConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  timeoutMs = CONSOLE_PROBE_TIMEOUT_MS,
): Promise<VisibleConsoles> {
  const others = sorted(
    (registry?.entries ?? []).filter(
      (entry) => entry.id !== selfId && isSameOriginPath(entry.path),
    ),
  );
  const { allowed } = await allowedEntries(others, context, timeoutMs);
  return {
    version: 1,
    current: selfId,
    consoles: allowed.map((entry) => ({
      id: entry.id,
      title: entry.title,
      icon: iconOf(entry.icon),
      href: entry.path,
    })),
  };
}

/**
 * Global search: `q` goes to every console the viewer may open that has a `search` (this one
 * included: the viewer is already in it), in parallel, `timeoutMs` each, at most
 * {@link CONSOLE_SEARCH_HITS} same-origin hits per console. Consoles with no hit are left out; a
 * console that did not answer in time sets `partial`. The probe marker is on the request while the
 * other consoles' `authorize` and every `search` run.
 */
export async function searchConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  q: unknown,
  timeoutMs = CONSOLE_PROBE_TIMEOUT_MS,
): Promise<ConsoleSearchResults> {
  const query = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  if (!registry || query === '') return { version: 1, q: query, partial: false, results: [] };
  const searchable = sorted(
    registry.entries.filter(
      (entry) => typeof entry.search === 'function' && isSameOriginPath(entry.path),
    ),
  );
  const self = searchable.filter((entry) => entry.id === selfId);
  const { allowed, unanswered } = await allowedEntries(
    searchable.filter((entry) => entry.id !== selfId),
    context,
    timeoutMs,
  );
  const targets = sorted([...self, ...allowed]);
  const answers = await probing(context, () =>
    Promise.all(
      targets.map((entry) =>
        within(
          async () => (await entry.search?.(context, query, CONSOLE_SEARCH_HITS)) ?? [],
          timeoutMs,
        ),
      ),
    ),
  );
  const results: ConsoleSearchResults['results'] = [];
  targets.forEach((entry, index) => {
    const answer = answers[index];
    const hits = answer?.ok && Array.isArray(answer.value) ? answer.value : [];
    const safe = hits
      .filter(
        (hit) =>
          typeof hit === 'object' &&
          hit !== null &&
          typeof hit.title === 'string' &&
          isSameOriginPath(hit.href),
      )
      .slice(0, CONSOLE_SEARCH_HITS)
      .map((hit) => ({
        title: hit.title,
        ...(typeof hit.subtitle === 'string' ? { subtitle: hit.subtitle } : {}),
        href: hit.href,
      }));
    if (safe.length > 0) {
      results.push({ id: entry.id, title: entry.title, icon: iconOf(entry.icon), hits: safe });
    }
  });
  return {
    version: 1,
    q: query,
    partial: unanswered || answers.some((answer) => !answer.ok),
    results,
  };
}

/** What {@link durableConsoleSearch} reads: a run by id, and workflow names with their counts. */
export interface DurableSearchSource {
  findRun(id: string): Promise<{ id: string; workflow: string; status: string } | null>;
  /** Workflow names containing `q`, with their run counts. */
  workflows(q: string, limit: number): Promise<Array<{ value: string | null; count: number }>>;
}

/**
 * The durable console's global search: an exact run id opens that run, and workflow names that
 * contain `q` open the workflow's page. `base` is the console's mount path.
 */
export function durableConsoleSearch(
  source: DurableSearchSource,
  base: string,
): (q: string, limit: number) => Promise<AviaryConsoleSearchHit[]> {
  const shell = base === '' ? '/' : base;
  return async (q, limit) => {
    const hits: AviaryConsoleSearchHit[] = [];
    const run = await source.findRun(q).catch(() => null);
    if (run) {
      hits.push({
        title: run.id,
        subtitle: `run · ${run.workflow} · ${run.status}`,
        href: `${shell}#/run/${encodeURIComponent(run.id)}`,
      });
    }
    const rows = await source.workflows(q, limit).catch(() => []);
    for (const row of rows) {
      if (hits.length >= limit) break;
      if (row.value === null) continue;
      hits.push({
        title: row.value,
        subtitle: `workflow · ${row.count} ${row.count === 1 ? 'run' : 'runs'}`,
        href: `${shell}#/workflow/${encodeURIComponent(row.value)}`,
      });
    }
    return hits.slice(0, limit);
  };
}

// ── the durable console's side ─────────────────────────────────────────────────

/** The durable console's id in the registry. */
export const DURABLE_CONSOLE_ID: string = 'durable';

const logger = new Logger('DurableDashboardModule');

/**
 * Registers the durable console into the switcher registry (the console's page path, gated by its
 * resolved `authorize`). Provided only when the console's routes are mounted; removed on shutdown.
 */
@Injectable()
export class DurableConsoleRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
    @Inject(CONSOLE_AUTHORIZE_DECIDE) private readonly decide: ConsoleDecide,
    private readonly dashboard: DashboardService,
  ) {}

  onModuleInit(): void {
    const search = durableConsoleSearch(
      {
        findRun: (id) => this.dashboard.findRun(id),
        workflows: (q, limit) =>
          this.dashboard.runValueFacets({ field: 'workflow' }, {}, { search: q, limit }),
      },
      this.basePath,
    );
    this.#unregister = registerAviaryConsole(
      {
        id: DURABLE_CONSOLE_ID,
        title: 'Workflows',
        icon: 'workflow',
        order: 10,
        path: this.basePath,
        authorize: (context) => this.decide(context),
        search: (_context, q, limit) => search(q, limit),
      },
      logger,
    );
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}

/** What the route hands on to the other consoles' `authorize`: this request's `ExecutionContext`. */
interface CurrentContext {
  context: ExecutionContext;
}

const CurrentExecutionContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentContext => ({ context }),
);

/**
 * `GET <api>/consoles`: the other Aviary consoles this viewer may open. Behind the console's own
 * access check, like every API route, so only someone who may open this console learns the list.
 */
@Controller()
export class DurableConsolesController {
  @Get('consoles')
  @Header('Cache-Control', 'private, no-store')
  consoles(@CurrentExecutionContext() current: CurrentContext): Promise<VisibleConsoles> {
    return listVisibleConsoles(readAviaryConsoles(), DURABLE_CONSOLE_ID, current.context);
  }

  /**
   * `GET <api>/consoles/search?q=`: `q` across this console and every other one the viewer may
   * open that can search (runs by id and workflows here), 5 hits each.
   */
  @Get('consoles/search')
  @Header('Cache-Control', 'private, no-store')
  search(
    @CurrentExecutionContext() current: CurrentContext,
    @Query('q') q: unknown,
  ): Promise<ConsoleSearchResults> {
    return searchConsoles(readAviaryConsoles(), DURABLE_CONSOLE_ID, current.context, q);
  }
}
