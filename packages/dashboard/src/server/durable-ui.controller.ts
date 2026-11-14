import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ConsolePage } from './console-authorize.js';
import {
  type ConsoleSignOutOption,
  type ConsoleViewerResolver,
  resolveConsoleSignOut,
  resolveConsoleViewer,
} from './console-shell.js';
import {
  DURABLE_CONSOLE_ID,
  consoleSwitcherConfig,
  readAviaryConsoles,
} from './console-switcher.js';
import { DASHBOARD_API_PATH, DASHBOARD_BASE_PATH, DASHBOARD_SHELL } from './tokens.js';

/** The console shell options a {@link DurableUiControllerBase} reads (`viewer`, `signOut`). */
export interface DurableShellOptions {
  viewer?: ConsoleViewerResolver | undefined;
  signOut?: ConsoleSignOutOption | undefined;
}

export { DASHBOARD_API_PATH, DASHBOARD_BASE_PATH };

/** The id of the page's JSON config block. */
export const DURABLE_DASHBOARD_CONFIG_ID = 'durable-dashboard-config';

/** The base the SPA bundle was built with (Vite `base`); rewritten to the configured base at serve time. */
const BUILD_BASE = '/durable';

/** dist/server/durable-ui.controller.js -> ../spa (the Vite build output). */
function spaDir(): string {
  return fileURLToPath(new URL('../spa', import.meta.url));
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

/**
 * Serves the bundled control-plane SPA at the configured base (+ hashed assets at `<base>/assets`).
 * The controller routes are relative: the mounted {@link DurableUiController} gets its path from
 * `RouterModule` (set by `DurableDashboardModule.forRoot({ basePath })`).
 *
 * This base is what a host EXTENDS to serve the console from a controller of its own (with
 * `forRoot({ routes: false, basePath })`): `@Controller('<basePath>') class MyConsole extends
 * DurableUiControllerBase {}`, protected with the host's own decorators. It carries no guards and
 * no `@nestjs/authorization` mark, so a subclass is protected only by what the host puts on it (and,
 * under `AuthorizationModule`'s global guard, is denied until it declares a `@Can()`).
 */
@Controller()
@ConsolePage()
export class DurableUiControllerBase {
  private readonly dir = spaDir();

  constructor(
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
    @Inject(DASHBOARD_API_PATH) private readonly apiBasePath: string,
    @Optional() @Inject(DASHBOARD_SHELL) private readonly shell: DurableShellOptions = {},
  ) {}

  // index.html references hash-named bundles, so it MUST NOT be cached (stale bundle = the
  // classic "stuck loading after a deploy"). The hashed assets below are immutable.
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  async index(@Req() request?: unknown): Promise<string> {
    const indexPath = join(this.dir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Dashboard is not built. Run the package build.');
    }
    // The bundle was built with Vite base `/durable/`; rewrite asset URLs to the configured base so
    // the SPA loads from `<base>/assets` wherever it's mounted, and tell the client its API base.
    const html = readFileSync(indexPath, 'utf8').replaceAll(
      `="${BUILD_BASE}/`,
      `="${this.basePath}/`,
    );
    // __DURABLE_BASE__ = where assets load; __DURABLE_API__ = where the SPA fetches the JSON API.
    const inject = `<script>window.__DURABLE_BASE__='${this.basePath}';window.__DURABLE_API__='${this.apiBasePath}';</script>${await this.configBlock(request)}`;
    return html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : inject + html;
  }

  /**
   * The page's JSON config block (`durable-dashboard-config`, CSP-safe: data, not script). It
   * carries `switcher` only when another Aviary console is registered; `search` (⌘K, answering per
   * console too) whenever this console is in the registry; `viewer` and `signOut` for the sidebar
   * footer when they resolve (see `DurableDashboardOptions.viewer` / `signOut`).
   */
  private async configBlock(request: unknown): Promise<string> {
    const switcher = consoleSwitcherConfig(DURABLE_CONSOLE_ID, `${this.apiBasePath}/consoles`);
    const registry = readAviaryConsoles();
    const registered = registry?.entries.some((entry) => entry.id === DURABLE_CONSOLE_ID);
    const viewer = await resolveConsoleViewer(request, this.shell?.viewer);
    const signOut = resolveConsoleSignOut(request, this.shell?.signOut, registry);
    const json = JSON.stringify({
      apiBase: this.apiBasePath,
      ...(switcher !== undefined ? { switcher } : {}),
      ...(registered
        ? { search: { endpoint: `${this.apiBasePath}/consoles/search`, self: DURABLE_CONSOLE_ID } }
        : {}),
      ...(viewer ? { viewer } : {}),
      ...(signOut ? { signOut } : {}),
    }).replaceAll('<', '\\u003c');
    return `<script type="application/json" id="${DURABLE_DASHBOARD_CONFIG_ID}">${json}</script>`;
  }

  @Get('assets/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  asset(@Param('file') file: string): StreamableFile {
    const safe = basename(file);
    if (safe !== file) throw new NotFoundException();
    const root = resolve(this.dir, 'assets');
    const assetPath = resolve(root, safe);
    if (!assetPath.startsWith(root + sep) || !existsSync(assetPath)) {
      throw new NotFoundException();
    }
    const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
    return new StreamableFile(readFileSync(assetPath), { type });
  }
}

/**
 * The SPA controller `DurableDashboardModule.forRoot(...)` mounts at `basePath`. The module puts
 * the `@nestjs/authorization` open mark on THIS class (and `decorators` on a per-registration
 * subclass of it), never on {@link DurableUiControllerBase}, so a host's own subclass of the base
 * inherits none of them.
 */
@Controller()
export class DurableUiController extends DurableUiControllerBase {}
