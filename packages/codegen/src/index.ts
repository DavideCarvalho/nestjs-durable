// Minimal structural shapes from @dudousxd/nestjs-codegen — kept local so this package builds without
// the framework installed. They match the route-injection contract used by every codegen extension.
interface RouteParam {
  name: string;
  source: 'path' | 'query';
}
interface RouteDescriptor {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  name: string;
  params: RouteParam[];
  contract: { contractSource: { query: string | null; body: string | null; response: string } };
}
interface CodegenExtension {
  name: string;
  transformRoutes(routes: RouteDescriptor[]): RouteDescriptor[];
}

function route(
  method: RouteDescriptor['method'],
  path: string,
  name: string,
  contract: { query: string | null; body: string | null; response: string },
  params: RouteParam[] = [],
): RouteDescriptor {
  return { method, path, name, params, contract: { contractSource: contract } };
}

// Wire shapes the durable dashboard API returns (JSON: dates are ISO strings).
const RUN =
  '{ id: string; workflow: string; workflowVersion: string; ' +
  "status: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'dead'; " +
  'input?: unknown; output?: unknown; error?: { message: string; code?: string }; ' +
  'wakeAt?: number; createdAt: string; updatedAt: string }';
const STEP =
  "{ runId: string; seq: number; name: string; kind: 'local' | 'remote' | 'sleep' | 'signal'; " +
  "status: 'completed' | 'failed'; output?: unknown; error?: { message: string }; attempts: number; " +
  'workerGroup?: string; wakeAt?: number; startedAt: string; finishedAt: string }';
const RUN_DETAIL = `{ run: ${RUN}; timeline: ${STEP}[] }`;

export interface NestjsDurableCodegenOptions {
  /**
   * Prefix where the durable dashboard's **API** is reachable through your codegen fetcher's base.
   * The dashboard mounts at `/durable` (API at `/durable/api`); since most fetchers prepend `/api`,
   * expose it under your base (e.g. a proxy at `/api/v1/control-panel/durable-runs`) and set that
   * here. Defaults to `/durable/api`.
   */
  basePath?: string;
  /** Client namespace for the generated methods (`api.<name>.*`). Defaults to `durable`. */
  name?: string;
}

/**
 * A [`@dudousxd/nestjs-codegen`](https://www.npmjs.com/package/@dudousxd/nestjs-codegen) extension
 * that emits the **durable dashboard API** — list runs, run detail, retry, cancel — into your
 * generated `api.ts`, so the control plane is a typed client / TanStack hooks in your frontend
 * (`api.durable.listRuns()`, `api.durable.getRun({ params: { id } })`, …).
 *
 * The dashboard mounts its routes via a factory that static AST discovery can't see, so this injects
 * them directly. Register it in your codegen config:
 *
 * ```ts
 * defineConfig({ extensions: [nestjsDurableCodegen({ basePath: '/durable/api' })] });
 * ```
 */
export function nestjsDurableCodegen(options: NestjsDurableCodegenOptions = {}): CodegenExtension {
  const base = (options.basePath ?? '/durable/api').replace(/\/+$/, '');
  const ns = options.name ?? 'durable';
  const id: RouteParam[] = [{ name: 'id', source: 'path' }];

  const injected: RouteDescriptor[] = [
    route('GET', `${base}/runs`, `${ns}.listRuns`, {
      query: "{ status?: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'dead' }",
      body: null,
      response: `${RUN}[]`,
    }),
    route(
      'GET',
      `${base}/runs/:id`,
      `${ns}.getRun`,
      {
        query: null,
        body: null,
        response: `${RUN_DETAIL} | null`,
      },
      id,
    ),
    route(
      'POST',
      `${base}/runs/:id/retry`,
      `${ns}.retry`,
      { query: null, body: null, response: RUN },
      id,
    ),
    route(
      'POST',
      `${base}/runs/:id/cancel`,
      `${ns}.cancel`,
      { query: "{ compensate?: 'true' }", body: null, response: RUN },
      id,
    ),
    route(
      'POST',
      `${base}/runs/:id/continue`,
      `${ns}.continue`,
      { query: null, body: null, response: RUN },
      id,
    ),
    route(
      'POST',
      `${base}/webhooks/:token`,
      `${ns}.deliverWebhook`,
      { query: null, body: 'unknown', response: RUN },
      [{ name: 'token', source: 'path' }],
    ),
    route(
      'GET',
      `${base}/runs/:id/events/:key`,
      `${ns}.getEvent`,
      { query: null, body: null, response: 'unknown' },
      [
        { name: 'id', source: 'path' },
        { name: 'key', source: 'path' },
      ],
    ),
    route(
      'POST',
      `${base}/runs/:id/updates/:name`,
      `${ns}.update`,
      {
        query: null,
        body: 'unknown',
        response: `{ accepted: false; reason: string } | { accepted: true; run: ${RUN} | null }`,
      },
      [
        { name: 'id', source: 'path' },
        { name: 'name', source: 'path' },
      ],
    ),
  ];

  return {
    name: 'nestjs-durable',
    transformRoutes(routes) {
      return [...routes, ...injected];
    },
  };
}
