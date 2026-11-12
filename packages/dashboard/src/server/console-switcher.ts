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
  createParamDecorator,
} from '@nestjs/common';
import { CONSOLE_AUTHORIZE_DECIDE, type ConsoleDecide } from './console-authorize.js';
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

/** How long another console's `authorize` may take before it is left out. */
export const CONSOLE_PROBE_TIMEOUT_MS: number = 300;

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

/** Whether `entry` allows the viewer within `ms`; a rejection or a timeout is a no. */
async function allows(
  entry: AviaryConsoleEntry,
  context: ExecutionContext,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => entry.authorize(context))
        .then(
          (decision) => decision?.allowed === true,
          () => false,
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const others = (registry?.entries ?? [])
    .filter((entry) => entry.id !== selfId && isSameOriginPath(entry.path))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const verdicts = await Promise.all(others.map((entry) => allows(entry, context, timeoutMs)));
  return {
    version: 1,
    current: selfId,
    consoles: others
      .filter((_, index) => verdicts[index])
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: ICONS.has(entry.icon) ? entry.icon : 'generic',
        href: entry.path,
      })),
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
  ) {}

  onModuleInit(): void {
    this.#unregister = registerAviaryConsole(
      {
        id: DURABLE_CONSOLE_ID,
        title: 'Workflows',
        icon: 'workflow',
        order: 10,
        path: this.basePath,
        authorize: (context) => this.decide(context),
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
}
