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
  listVisibleConsoles,
  readAviaryConsoles,
  registerAviaryConsole,
} from './console-switcher.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { DurableUiController } from './durable-ui.controller.js';

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

// ── HTTP ───────────────────────────────────────────────────────────────────

const gateway = {
  topology: () => ({ role: 'control-plane' }),
  async listRuns() {
    return [];
  },
  async runFacets() {
    return [];
  },
  async runValueFacets() {
    return [];
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

  function shell(): { html: string; config: Record<string, unknown> } {
    const controller = Object.assign(new DurableUiController('/flows', '/api/flows'), {
      dir,
    }) as unknown as DurableUiController;
    const html = controller.index();
    const match = html.match(
      /<script type="application\/json" id="durable-dashboard-config">([^<]*)<\/script>/,
    );
    if (!match?.[1]) throw new Error('no config block');
    return { html, config: JSON.parse(match[1]) as Record<string, unknown> };
  }

  it('has no switcher while the durable console is alone', () => {
    registerAviaryConsole(entry({ id: 'durable', path: '/flows' }));
    expect(shell().config).toEqual({ apiBase: '/api/flows' });
  });

  it('carries the endpoint and how many others are registered, as data (CSP-safe)', () => {
    registerAviaryConsole(entry({ id: 'durable', path: '/flows' }));
    registerAviaryConsole(entry({ id: 'media' }));
    registerAviaryConsole(entry({ id: 'agent' }));
    const { html, config } = shell();
    expect(config).toEqual({
      apiBase: '/api/flows',
      switcher: { endpoint: '/api/flows/consoles', others: 2 },
    });
    // The block is JSON data, not script: a `script-src 'self' 'nonce-x'` page still parses it.
    expect(html).toContain('<script type="application/json" id="durable-dashboard-config">');
    expect(html).toContain('src="/flows/assets/app.js"');
  });
});
