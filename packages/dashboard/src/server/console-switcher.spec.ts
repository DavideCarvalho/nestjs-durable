import { RunGateway } from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DynamicModule, type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConsoleDecision, authorizeByToken } from './console-authorize.js';
import {
  AVIARY_CONSOLES_SLOT,
  type AviaryConsoleEntry,
  type AviaryConsoleRegistry,
  consoleSwitcherConfig,
  durableConsoleSearch,
  isSameOriginPath,
  listVisibleConsoles,
  readAviaryConsoles,
  registerAviaryConsole,
  searchConsoles,
} from './console-switcher.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { type DurableShellOptions, DurableUiController } from './durable-ui.controller.js';

const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;
const context = {} as ExecutionContext;

const allow = async (): Promise<ConsoleDecision> => ({ allowed: true });
const deny = async (): Promise<ConsoleDecision> => ({ allowed: false, reason: 'forbidden' });

function entry(overrides: Partial<AviaryConsoleEntry> & { id: string }): AviaryConsoleEntry {
  return {
    title: overrides.id,
    icon: 'generic',
    path: `/${overrides.id}`,
    order: 50,
    authorize: allow,
    ...overrides,
  };
}

function registry(...entries: AviaryConsoleEntry[]): AviaryConsoleRegistry {
  return { version: 1, entries };
}

beforeEach(() => {
  delete holder[AVIARY_CONSOLES_SLOT];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerAviaryConsole', () => {
  it('creates the registry when absent, and the returned function removes the entry', () => {
    const remove = registerAviaryConsole(entry({ id: 'media' }));
    expect(readAviaryConsoles()?.entries.map((e) => e.id)).toEqual(['media']);
    remove?.();
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('appends to a registry another console created (two copies, one registry)', () => {
    const existing = registry(entry({ id: 'durable' }));
    holder[AVIARY_CONSOLES_SLOT] = existing;
    registerAviaryConsole(entry({ id: 'media' }));
    expect(holder[AVIARY_CONSOLES_SLOT]).toBe(existing);
    expect(existing.entries.map((e) => e.id)).toEqual(['durable', 'media']);
  });

  it('leaves a registry of another version alone', () => {
    const future = { version: 2, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = future;
    expect(registerAviaryConsole(entry({ id: 'media' }))).toBeUndefined();
    expect(future.entries).toEqual([]);
  });

  it('warns and skips a duplicate id', () => {
    const warn = vi.fn();
    registerAviaryConsole(entry({ id: 'media' }));
    expect(registerAviaryConsole(entry({ id: 'media', title: 'Other' }), { warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('console id "media" is already registered');
    expect(readAviaryConsoles()?.entries).toHaveLength(1);
  });

  it('rejects a bad id or a path that is not same-origin', () => {
    expect(() => registerAviaryConsole(entry({ id: 'Agent' }))).toThrow(/id/);
    expect(() => registerAviaryConsole(entry({ id: 'media', path: '//evil.test' }))).toThrow(
      /path/,
    );
    expect(() => registerAviaryConsole(entry({ id: 'media', path: 'https://x.test' }))).toThrow(
      /path/,
    );
  });
});

describe('isSameOriginPath', () => {
  it('accepts a plain absolute path, rejects other origins, backslashes and control characters', () => {
    expect(isSameOriginPath('/durable#/run/1')).toBe(true);
    for (const bad of [
      '//evil.test',
      'https://evil.test',
      '/\\evil.test',
      '/a\u0007b',
      '/a\nb',
      '/a\u007fb',
      'x',
      1,
    ]) {
      expect(isSameOriginPath(bad)).toBe(false);
    }
  });
});

describe('consoleSwitcherConfig', () => {
  it('is absent when this console is alone or not registered, and counts the others', () => {
    expect(consoleSwitcherConfig('media', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'durable' }));
    expect(consoleSwitcherConfig('media', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'media' }));
    expect(consoleSwitcherConfig('media', '/a/consoles')).toEqual({
      endpoint: '/a/consoles',
      others: 1,
    });
  });
});

describe('listVisibleConsoles', () => {
  it('lists the allowed others by order then id, never self, with href = path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'media', order: 50, icon: 'media', title: 'Media' }),
        entry({ id: 'agent', order: 30, icon: 'agent', title: 'Agents' }),
        entry({ id: 'telescope', order: 20, icon: 'telescope', title: 'Telescope' }),
        entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
        entry({ id: 'zzz', order: 30 }),
      ),
      'media',
      context,
    );
    expect(result).toEqual({
      version: 1,
      current: 'media',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
        { id: 'agent', title: 'Agents', icon: 'agent', href: '/agent' },
        { id: 'zzz', title: 'zzz', icon: 'generic', href: '/zzz' },
      ],
    });
  });

  it('hides forbidden, redirectTo, rejecting and throwing entries, and returns no reason', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'ok' }),
        entry({ id: 'forbidden', authorize: deny }),
        entry({
          id: 'redirect',
          authorize: async () => ({
            allowed: false,
            reason: 'unauthenticated',
            redirectTo: '/login',
          }),
        }),
        entry({ id: 'rejects', authorize: () => Promise.reject(new Error('boom')) }),
        entry({
          id: 'throws',
          authorize: () => {
            throw new Error('sync boom');
          },
        }),
      ),
      'media',
      context,
    );
    expect(result.consoles.map((c) => c.id)).toEqual(['ok']);
    expect(JSON.stringify(result)).not.toMatch(/forbidden|unauthenticated|login|boom/);
  });

  it('passes the request context to each authorize', async () => {
    const authorize = vi.fn(allow);
    await listVisibleConsoles(registry(entry({ id: 'x', authorize })), 'media', context);
    expect(authorize).toHaveBeenCalledWith(context);
  });

  it('maps an unknown icon to generic and drops an unsafe path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'odd', icon: 'rocket' as never }),
        entry({ id: 'evil', path: '//evil.test' }),
        entry({ id: 'slash', path: '/\\evil.test' }),
        entry({ id: 'ctl', path: '/ctl\u0007x' }),
      ),
      'media',
      context,
    );
    expect(result.consoles).toEqual([{ id: 'odd', title: 'odd', icon: 'generic', href: '/odd' }]);
  });

  it('runs every authorize in parallel, each given 300 ms; a slower one is hidden', async () => {
    vi.useFakeTimers();
    const settleAfter = (ms: number, decision: ConsoleDecision) => () =>
      new Promise<ConsoleDecision>((resolve) => setTimeout(() => resolve(decision), ms));
    const pending = listVisibleConsoles(
      registry(
        entry({ id: 'a', order: 1, authorize: settleAfter(250, { allowed: true }) }),
        entry({ id: 'b', order: 2, authorize: settleAfter(280, { allowed: true }) }),
        entry({ id: 'slow', order: 3, authorize: settleAfter(5_000, { allowed: true }) }),
      ),
      'media',
      context,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // In sequence, a + b alone would take 530 ms; in parallel, everything settles by the timeout.
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(true);
    expect((await pending).consoles.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('answers an empty list without a registry', async () => {
    expect(await listVisibleConsoles(undefined, 'media', context)).toEqual({
      version: 1,
      current: 'media',
      consoles: [],
    });
  });
});

describe('searchConsoles', () => {
  const hit = (title: string, href = `/${title}`) => ({ title, href });

  it('asks this console and every other allowed one, 5 safe hits each, by order', async () => {
    const seen: Array<[string, number]> = [];
    const result = await searchConsoles(
      registry(
        entry({
          id: 'durable',
          order: 10,
          authorize: deny, // its own gate already passed: never asked again
          search: async (_ctx, q, limit) => {
            seen.push([q, limit]);
            return Array.from({ length: 7 }, (_, i) => hit(`run-${i}`, `/durable#/run/${i}`));
          },
        }),
        entry({
          id: 'media',
          order: 50,
          search: async () => [
            hit('a.png'),
            { title: 'evil', href: 'https://evil.example' },
            { title: 'proto', href: '//evil.example' },
            { title: 'backslash', href: '/\\evil.test' },
            { title: 'control', href: '/a\u0000b' },
            { title: 3, href: '/x' } as never,
          ],
        }),
        entry({ id: 'agent', order: 30, authorize: deny, search: async () => [hit('thread')] }),
        entry({ id: 'telescope', order: 20, search: async () => [] }),
        entry({ id: 'plain', order: 40 }),
      ),
      'durable',
      context,
      '  run  ',
    );
    expect(seen).toEqual([['run', 5]]);
    expect(result.q).toBe('run');
    expect(result.partial).toBe(false);
    expect(result.results.map((r) => [r.id, r.hits.length])).toEqual([
      ['durable', 5],
      ['media', 1],
    ]);
    expect(result.results[1]?.hits).toEqual([{ title: 'a.png', href: '/a.png' }]);
  });

  it('answers for one console only when asked (`console=<id>`), still behind its gate', async () => {
    const asked: string[] = [];
    const reg = registry(
      entry({
        id: 'durable',
        search: async () => {
          asked.push('durable');
          return [hit('run-1')];
        },
      }),
      entry({
        id: 'media',
        search: async () => {
          asked.push('media');
          return [hit('a.png')];
        },
      }),
      entry({ id: 'agent', authorize: deny, search: async () => [hit('thread')] }),
    );
    const media = await searchConsoles(reg, 'durable', context, 'x', 300, 'media');
    expect(media.results.map((r) => r.id)).toEqual(['media']);
    expect(asked).toEqual(['media']);
    expect((await searchConsoles(reg, 'durable', context, 'x', 300, 'agent')).results).toEqual([]);
    expect((await searchConsoles(reg, 'durable', context, 'x', 300, 'nope')).results).toEqual([]);
  });

  it('answers nothing for a blank query or without a registry', async () => {
    expect(await searchConsoles(undefined, 'durable', context, 'x')).toEqual({
      version: 1,
      q: 'x',
      partial: false,
      results: [],
    });
    expect((await searchConsoles(registry(), 'durable', context, '   ')).results).toEqual([]);
    expect((await searchConsoles(registry(), 'durable', context, undefined)).q).toBe('');
  });

  it('reports partial when a console times out or fails, and keeps the others', async () => {
    const slow = () => new Promise<never>(() => undefined);
    const result = await searchConsoles(
      registry(
        entry({ id: 'durable', order: 10, search: async () => [hit('r1')] }),
        entry({ id: 'media', order: 50, search: slow }),
      ),
      'durable',
      context,
      'r',
      30,
    );
    expect(result.partial).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(['durable']);

    const unanswered = await searchConsoles(
      registry(
        entry({ id: 'durable', order: 10, search: async () => [hit('r1')] }),
        entry({ id: 'media', order: 50, authorize: slow, search: async () => [hit('m')] }),
      ),
      'durable',
      context,
      'r',
      30,
    );
    expect(unanswered.partial).toBe(true);
    expect(unanswered.results.map((r) => r.id)).toEqual(['durable']);

    const failing = await searchConsoles(
      registry(
        entry({
          id: 'durable',
          order: 10,
          search: async () => {
            throw new Error('down');
          },
        }),
      ),
      'durable',
      context,
      'r',
    );
    expect(failing).toMatchObject({ partial: true, results: [] });
  });
});

describe('the probe marker', () => {
  it('is on the request while other consoles authorize and search, and gone afterwards', async () => {
    const request: { headers: Record<string, string>; aviaryProbe?: boolean } = { headers: {} };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getType: () => 'http',
    } as unknown as ExecutionContext;
    const marks: Array<[string, unknown]> = [];
    const probe = (label: string) => (c: ExecutionContext) =>
      marks.push([label, c.switchToHttp().getRequest<typeof request>().aviaryProbe]);
    const reg = registry(
      entry({
        id: 'media',
        authorize: async (c) => {
          probe('authorize')(c);
          return { allowed: true };
        },
        search: async (c) => {
          probe('search')(c);
          return [];
        },
      }),
    );
    await listVisibleConsoles(reg, 'durable', ctx);
    expect(request.aviaryProbe).toBeUndefined();
    await searchConsoles(reg, 'durable', ctx, 'q');
    expect(Object.hasOwn(request, 'aviaryProbe')).toBe(false);
    expect(marks).toEqual([
      ['authorize', true],
      ['authorize', true],
      ['search', true],
    ]);
  });
});

describe('durableConsoleSearch', () => {
  it('opens an exact run id, then workflow names containing q', async () => {
    const search = durableConsoleSearch(
      {
        findRun: async (id) => (id === 'run-1' ? { id, workflow: 'w', status: 'failed' } : null),
        workflows: async () => [
          { value: 'run-tracker', count: 1 },
          { value: null, count: 2 },
          { value: 'run log', count: 2 },
        ],
      },
      '/ops',
    );
    expect(await search('run-1', 5)).toEqual([
      { title: 'run-1', subtitle: 'run · w · failed', href: '/ops#/run/run-1' },
      { title: 'run-tracker', subtitle: 'workflow · 1 run', href: '/ops#/workflow/run-tracker' },
      { title: 'run log', subtitle: 'workflow · 2 runs', href: '/ops#/workflow/run%20log' },
    ]);
    expect(await search('run-1', 2)).toHaveLength(2);
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────────

const gateway = {
  topology: () => ({ role: 'control-plane' }),
  async listRuns() {
    return [];
  },
  async runFacets() {
    return [];
  },
  async runValueFacets(axis: { field: string }, _query: unknown, opts?: { search?: string }) {
    const names = ['checkout', 'checkout-refund', 'billing'];
    return axis.field === 'workflow'
      ? names
          .filter((name) => name.includes(opts?.search ?? ''))
          .map((value) => ({ value, count: value === 'checkout' ? 1 : 3 }))
      : [];
  },
  async getRun(id: string) {
    return id === 'run-1' ? { id, workflow: 'checkout', status: 'completed' } : null;
  },
};

@Global()
@Module({ providers: [{ provide: RunGateway, useValue: gateway }], exports: [RunGateway] })
class HostGatewayModule {}

let close: (() => Promise<void>) | undefined;

async function boot(dashboard: DynamicModule): Promise<string> {
  @Module({ imports: [HostGatewayModule, dashboard] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.listen(0);
  close = () => app.close();
  return app.getUrl();
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

const bearer = { authorization: `Bearer ${TOKEN}` };

function httpContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('the durable console in the switcher', () => {
  it('registers itself at its page path when mounted, gated by its own authorize, and leaves on close', async () => {
    await boot(
      DurableDashboardModule.forRoot({
        basePath: '/ops/workflows',
        authorize: authorizeByToken({ token: TOKEN }),
      }),
    );
    const [durable] = readAviaryConsoles()?.entries ?? [];
    expect(durable).toMatchObject({
      id: 'durable',
      title: 'Workflows',
      icon: 'workflow',
      order: 10,
      path: '/ops/workflows',
    });
    expect((await durable?.authorize(httpContext(bearer)))?.allowed).toBe(true);
    expect((await durable?.authorize(httpContext({})))?.allowed).toBe(false);
    await close?.();
    close = undefined;
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('does not register with routes: false', async () => {
    await boot(DurableDashboardModule.forRoot({ routes: false, authorize: () => true }));
    expect(readAviaryConsoles()?.entries ?? []).toEqual([]);
  });

  it('GET <api>/consoles is behind the console’s own authorize', async () => {
    registerAviaryConsole(entry({ id: 'media', order: 50, icon: 'media', title: 'Media' }));
    const url = await boot(
      DurableDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }),
    );
    const denied = await fetch(`${url}/durable/api/consoles`, {
      headers: { accept: 'application/json' },
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'unauthenticated' });
  });

  it('GET <api>/consoles lists the others the viewer may open, private and uncached', async () => {
    registerAviaryConsole(entry({ id: 'media', order: 50, icon: 'media', title: 'Media' }));
    registerAviaryConsole(entry({ id: 'agent', order: 30, authorize: deny }));
    registerAviaryConsole(
      entry({
        id: 'telescope',
        order: 20,
        icon: 'telescope',
        title: 'Telescope',
        // Sees the same request the durable console was asked with.
        authorize: async (ctx) => ({
          allowed:
            ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
              'x-telescope'
            ] === 'yes',
        }),
      }),
    );
    const url = await boot(
      DurableDashboardModule.forRoot({
        apiBasePath: '/api/durable',
        authorize: authorizeByToken({ token: TOKEN }),
      }),
    );
    const res = await fetch(`${url}/api/durable/consoles`, {
      headers: { ...bearer, 'x-telescope': 'yes' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      version: 1,
      current: 'durable',
      consoles: [
        { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
        { id: 'media', title: 'Media', icon: 'media', href: '/media' },
      ],
    });
    const without = await fetch(`${url}/api/durable/consoles`, { headers: bearer });
    const body = (await without.json()) as { consoles: { id: string }[] };
    expect(body.consoles.map((c) => c.id)).toEqual(['media']);
  });
});

describe('GET <api>/consoles/search', () => {
  it('searches runs by id and workflows here, plus the other allowed consoles, behind the gate', async () => {
    registerAviaryConsole(
      entry({
        id: 'media',
        order: 50,
        icon: 'media',
        title: 'Media',
        search: async (_ctx, q) => [{ title: `${q}.png`, href: `/media#/file/${q}` }],
      }),
    );
    registerAviaryConsole(
      entry({
        id: 'agent',
        order: 30,
        authorize: deny,
        search: async () => [{ title: 'x', href: '/x' }],
      }),
    );
    const url = await boot(
      DurableDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }),
    );
    const denied = await fetch(`${url}/durable/api/consoles/search?q=run-1`, {
      headers: { accept: 'application/json' },
    });
    expect(denied.status).toBe(401);

    const res = await fetch(`${url}/durable/api/consoles/search?q=run-1`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      version: 1,
      q: 'run-1',
      partial: false,
      results: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [
            {
              title: 'run-1',
              subtitle: 'run · checkout · completed',
              href: '/durable#/run/run-1',
            },
          ],
        },
        {
          id: 'media',
          title: 'Media',
          icon: 'media',
          hits: [{ title: 'run-1.png', href: '/media#/file/run-1' }],
        },
      ],
    });

    const byWorkflow = await fetch(`${url}/durable/api/consoles/search?q=checkout`, {
      headers: bearer,
    });
    const body = (await byWorkflow.json()) as { results: Array<{ id: string; hits: unknown[] }> };
    expect(body.results[0]?.hits).toEqual([
      { title: 'checkout', subtitle: 'workflow · 1 run', href: '/durable#/workflow/checkout' },
      {
        title: 'checkout-refund',
        subtitle: 'workflow · 3 runs',
        href: '/durable#/workflow/checkout-refund',
      },
    ]);
  });
});

describe('the shell’s config block', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-shell-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/durable/assets/app.js" nonce="x"></script></head><body></body></html>',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function shell(
    options: DurableShellOptions = {},
    request: unknown = {},
  ): Promise<{ html: string; config: Record<string, unknown> }> {
    const controller = Object.assign(new DurableUiController('/flows', '/api/flows', options), {
      dir,
    }) as unknown as DurableUiController;
    const html = await controller.index(request);
    const match = html.match(
      /<script type="application\/json" id="durable-dashboard-config">([^<]*)<\/script>/,
    );
    if (!match?.[1]) throw new Error('no config block');
    return { html, config: JSON.parse(match[1]) as Record<string, unknown> };
  }

  const search = { endpoint: '/api/flows/consoles/search', self: 'durable' };

  it('has no switcher while the durable console is alone, but still its own ⌘K search', async () => {
    registerAviaryConsole(entry({ id: 'durable', path: '/flows' }));
    expect((await shell()).config).toEqual({ apiBase: '/api/flows', search });
  });

  it('has neither switcher nor search when the console is not registered', async () => {
    expect((await shell()).config).toEqual({ apiBase: '/api/flows' });
  });

  it('carries the endpoint and how many others are registered, as data (CSP-safe)', async () => {
    registerAviaryConsole(entry({ id: 'durable', path: '/flows' }));
    registerAviaryConsole(entry({ id: 'media' }));
    registerAviaryConsole(entry({ id: 'agent' }));
    const { html, config } = await shell();
    expect(config).toEqual({
      apiBase: '/api/flows',
      switcher: { endpoint: '/api/flows/consoles', others: 2 },
      search,
    });
    // The block is JSON data, not script: a `script-src 'self' 'nonce-x'` page still parses it.
    expect(html).toContain('<script type="application/json" id="durable-dashboard-config">');
    expect(html).toContain('src="/flows/assets/app.js"');
  });

  it('reads the viewer from request.user, and signOut from the option, escaped like the rest', async () => {
    const { html, config } = await shell(
      { signOut: { action: '/logout', csrfToken: () => 'tok' } },
      { user: { fullName: '</script><b>', email: 'ann@x.test', roles: [{ name: 'admin' }] } },
    );
    expect(html.split('</script>').length).toBe(4);
    expect(config).toEqual({
      apiBase: '/api/flows',
      viewer: { label: '</script><b>', email: 'ann@x.test', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 'tok' },
    });
  });

  it('uses the viewer option over request.user, and an announced sign-out as a fallback', async () => {
    (globalThis as Record<symbol, unknown>)[AVIARY_CONSOLES_SLOT] = {
      version: 1,
      entries: [],
      account: { signOut: { href: '/account/logout' } },
    };
    const { config } = await shell(
      { viewer: async () => ({ label: 'Ops', role: 'support' }) },
      { user: { email: 'ignored@x.test' } },
    );
    expect(config).toEqual({
      apiBase: '/api/flows',
      viewer: { label: 'Ops', role: 'support' },
      signOut: { href: '/account/logout' },
    });
    expect((await shell({ signOut: false })).config).toEqual({ apiBase: '/api/flows' });
  });
});
