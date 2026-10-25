import {
  InMemoryStateStore,
  InMemoryTransport,
  type StateStore,
} from '@dudousxd/nestjs-durable-core';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'boot-job', version: '1' })
class BootJob {
  async run() {
    return 1;
  }
}

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

/**
 * A store whose `method` never answers once armed: the first timer poll (or retention prune) hangs
 * the way a sweep over a large backlog did on a real database.
 */
function hangingStore(method: string, override: Partial<StateStore> = {}) {
  const calls: string[] = [];
  const inner = new InMemoryStateStore();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const overridden = (override as Record<string | symbol, unknown>)[prop];
      const value = overridden ?? Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        if (prop === method) return new Promise(() => {});
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as StateStore;
  return { store, calls };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timed out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed out'>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('booting does not wait for the first timer poll', () => {
  it('[boot-poll] the app listens and answers /health while the first poll hangs, and close still drains', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, calls } = hangingStore('listPendingRuns');
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          timerPollMs: 20,
          shutdownTimeoutMs: 200,
        }),
      ],
      controllers: [HealthController],
      providers: [BootJob],
    }).compile();
    const app = moduleRef.createNestApplication();

    expect(await withTimeout(app.listen(0), 2_000)).not.toBe('timed out');
    expect(calls).toContain('listPendingRuns'); // the poll did start, and is still hanging
    const url = await app.getUrl();
    const res = await fetch(`${url.replace('[::1]', 'localhost')}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const started = Date.now();
    expect(await withTimeout(app.close(), 3_000)).not.toBe('timed out');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // it waited for the poll, bounded
    expect(warn.mock.calls.flat().join(' ')).toMatch(/timer poll still running after 200ms/);
  });

  it('[boot-retention] the app boots while the first retention prune hangs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, calls } = hangingStore('pruneTerminalRuns', {
      pruneTerminalRuns: async () => 0,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          timerPollMs: 0,
          shutdownTimeoutMs: 100,
          retention: { sweepInterval: 0, policies: [{ statuses: ['completed'], maxAge: '1d' }] },
        }),
      ],
      providers: [BootJob],
    }).compile();

    expect(await withTimeout(moduleRef.init(), 2_000)).not.toBe('timed out');
    expect(calls).toContain('pruneTerminalRuns');
    expect(await withTimeout(moduleRef.close(), 3_000)).not.toBe('timed out');
  });
});
