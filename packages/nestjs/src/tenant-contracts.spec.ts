import {
  type Heartbeat,
  InMemoryStateStore,
  type RunReply,
  type RunRequest,
  type StartRunMessage,
  type StepResult,
  type Transport,
} from '@dudousxd/nestjs-durable-core';
import { Global, Injectable, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import {
  RunGateway,
  type TenantCredentialsContract,
  type TenantVerifierContract,
  type TenantVerifierInput,
  type VerifiedTenant,
  hmacTenantVerifier,
  signTenantToken,
} from './index';
import { resolveTenantTokenSource, resolveTenantVerifier } from './tenant-contracts';

const SECRET = 'contracts-secret';
const ACME = { tenant: 'acme' };

afterEach(() => vi.restoreAllMocks());

describe('resolveTenantVerifier', () => {
  it('passes a function through, and undefined stays undefined', async () => {
    expect(resolveTenantVerifier(undefined)).toBeUndefined();
    const verify = resolveTenantVerifier(hmacTenantVerifier(SECRET));
    expect(await verify?.({ token: signTenantToken('acme', SECRET) })).toEqual(ACME);
    expect(await verify?.({ token: 'acme' })).toBeNull();
  });

  it('calls verify() on an object implementing the contract', async () => {
    const object: TenantVerifierContract = { verify: vi.fn(async () => ACME) };
    const verify = resolveTenantVerifier(object);
    expect(await verify?.({ token: 't', tenant: 'x' })).toEqual(ACME);
    expect(object.verify).toHaveBeenCalledWith({ token: 't', tenant: 'x' });
  });

  it('builds a class once', async () => {
    let built = 0;
    class Verifier implements TenantVerifierContract {
      constructor() {
        built++;
      }
      verify({ token }: TenantVerifierInput): VerifiedTenant | null {
        return token === 'ok' ? ACME : null;
      }
    }
    const verify = resolveTenantVerifier(Verifier);
    expect(await Promise.all([verify?.({ token: 'ok' }), verify?.({ token: 'no' })])).toEqual([
      ACME,
      null,
    ]);
    expect(await verify?.({ token: 'ok' })).toEqual(ACME);
    expect(built).toBe(1);
  });

  it('treats a class whose verify is an arrow-function property as the class form', async () => {
    class Verifier implements TenantVerifierContract {
      verify = (): VerifiedTenant => ACME;
    }
    expect(await resolveTenantVerifier(Verifier)?.({ token: 't' })).toEqual(ACME);
  });

  it('imports a lazy module once and builds its default class once, even under concurrency', async () => {
    let built = 0;
    class Verifier implements TenantVerifierContract {
      constructor() {
        built++;
      }
      verify(): VerifiedTenant {
        return ACME;
      }
    }
    const load = vi.fn(async () => ({ default: Verifier }));
    const verify = resolveTenantVerifier(load);
    const results = await Promise.all([1, 2, 3].map(() => verify?.({ token: 't' })));
    expect(results).toEqual([ACME, ACME, ACME]);
    await verify?.({ token: 't' });
    expect(built).toBe(1);
    // The concurrent first calls each asked for the module; after that, never again.
    const calls = load.mock.calls.length;
    await verify?.({ token: 't' });
    expect(load.mock.calls.length).toBe(calls);
  });

  it('accepts a lazy module whose default export is an object', async () => {
    const object: TenantVerifierContract = { verify: () => ACME };
    const load = vi.fn(async () => ({ default: object }));
    const verify = resolveTenantVerifier(load);
    expect(await verify?.({ token: 't' })).toEqual(ACME);
    expect(await verify?.({ token: 't' })).toEqual(ACME);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a verifier that throws rejects the call, in every form', async () => {
    const boom = (): never => {
      throw new Error('idp down');
    };
    class Throwing implements TenantVerifierContract {
      verify = boom;
    }
    for (const option of [boom, { verify: boom }, Throwing, async () => ({ default: Throwing })]) {
      await expect(resolveTenantVerifier(option)?.({ token: 't' })).rejects.toThrow('idp down');
    }
  });

  it('a class that fails to build is built again on the next call', async () => {
    let attempts = 0;
    class Flaky implements TenantVerifierContract {
      constructor() {
        attempts++;
        if (attempts === 1) throw new Error('not yet');
      }
      verify(): VerifiedTenant {
        return ACME;
      }
    }
    const verify = resolveTenantVerifier(Flaky);
    await expect(verify?.({ token: 't' })).rejects.toThrow('not yet');
    expect(await verify?.({ token: 't' })).toEqual(ACME);
  });

  it('rejects an option of no known form', () => {
    expect(() => resolveTenantVerifier({} as unknown as TenantVerifierContract)).toThrow(
      /`verifyTenant` must be a function/,
    );
  });

  it('resolving a resolved verifier returns it unchanged', () => {
    const once = resolveTenantVerifier({ verify: () => ACME });
    expect(resolveTenantVerifier(once)).toBe(once);
  });
});

describe('resolveTenantTokenSource', () => {
  it('passes a string through, and undefined stays undefined', () => {
    expect(resolveTenantTokenSource(undefined)).toBeUndefined();
    expect(resolveTenantTokenSource('static-token')).toBe('static-token');
  });

  it('calls a function before every request', async () => {
    let n = 0;
    const source = resolveTenantTokenSource(async () => `token-${++n}`) as () => Promise<string>;
    expect([await source(), await source()]).toEqual(['token-1', 'token-2']);
  });

  it('calls token() on an object, a class built once, and a lazy import loaded once', async () => {
    let built = 0;
    let n = 0;
    class Credentials implements TenantCredentialsContract {
      constructor() {
        built++;
      }
      token(): string {
        return `class-${++n}`;
      }
    }
    const load = vi.fn(async () => ({ default: Credentials }));
    const fromObject = resolveTenantTokenSource({ token: () => 'object' }) as () => Promise<string>;
    const fromClass = resolveTenantTokenSource(Credentials) as () => Promise<string>;
    const fromLazy = resolveTenantTokenSource(load) as () => Promise<string>;
    expect(await fromObject()).toBe('object');
    expect([await fromClass(), await fromClass()]).toEqual(['class-1', 'class-2']);
    expect([await fromLazy(), await fromLazy()]).toEqual(['class-3', 'class-4']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(built).toBe(2); // one per registration: the class form and the lazy form
  });

  it('an empty token or a throw fails that request, and the next one asks again', async () => {
    let n = 0;
    const source = resolveTenantTokenSource({
      token: () => {
        n++;
        if (n === 1) return '';
        if (n === 2) throw new Error('idp down');
        return 'fresh';
      },
    }) as () => Promise<string>;
    await expect(source()).rejects.toThrow(/no token/);
    await expect(source()).rejects.toThrow('idp down');
    expect(await source()).toBe('fresh');
  });
});

// ------------------------------------------------------------------------------------------------
// Through DurableModule: classes are built by Nest DI via ModuleRef.
// ------------------------------------------------------------------------------------------------

/** A dependency the verifier and credentials classes inject. */
@Injectable()
class TenantDirectory {
  readonly secret = SECRET;
  lookups = 0;
}

@Global()
@Module({ providers: [TenantDirectory], exports: [TenantDirectory] })
class DirectoryModule {}

@Injectable()
class DirectoryVerifier implements TenantVerifierContract {
  static built = 0;
  constructor(private readonly directory: TenantDirectory) {
    DirectoryVerifier.built++;
  }
  verify(input: TenantVerifierInput) {
    this.directory.lookups++;
    return hmacTenantVerifier(this.directory.secret)(input);
  }
}

@Injectable()
class DirectoryCredentials implements TenantCredentialsContract {
  constructor(private readonly directory: TenantDirectory) {}
  token(): string {
    return signTenantToken('acme', this.directory.secret);
  }
}

/** An operator transport carrying run requests and start-runs, driven by the test. */
class OperatorTransport implements Transport {
  request?: (msg: RunRequest) => Promise<void>;
  startRun?: (msg: StartRunMessage) => Promise<void>;
  replies: RunReply[] = [];
  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.request = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    this.replies.push(reply);
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.startRun = handler;
  }
}

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run() {
    return 'hi';
  }
}

async function bootOperator(
  verifyTenant: DurableModuleOptions['verifyTenant'],
  providers: unknown[] = [],
) {
  const transport = new OperatorTransport();
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DirectoryModule,
      DurableModule.forRoot({
        topology: 'control-plane',
        store,
        transport,
        timerPollMs: 0,
        ...(verifyTenant !== undefined ? { verifyTenant } : {}),
      }),
    ],
    providers: [GreetWorkflow, ...(providers as never[])],
  }).compile();
  await moduleRef.init();
  return { moduleRef, transport, store };
}

describe('DurableModule verifyTenant through Nest DI', () => {
  it('builds an unregistered class with ModuleRef.create, injecting its dependencies, once', async () => {
    DirectoryVerifier.built = 0;
    const { moduleRef, transport } = await bootOperator(DirectoryVerifier);
    for (const tenant of [signTenantToken('acme', SECRET), 'forged']) {
      await transport.request?.({
        requestId: tenant,
        tenant,
        body: { kind: 'listRuns', query: {} },
      });
    }
    expect(transport.replies.map((r) => r.result.ok)).toEqual([true, false]);
    expect(transport.replies[1]?.result).toMatchObject({ error: { code: 'unauthorized' } });
    expect(moduleRef.get(TenantDirectory).lookups).toBe(2);
    expect(DirectoryVerifier.built).toBe(1);
    await moduleRef.close();
  });

  it('a class whose dependency DI cannot reach fails the request with a hint', async () => {
    @Injectable()
    class Hidden {}
    @Module({ providers: [Hidden] })
    class HiddenModule {}
    @Injectable()
    class NeedsHidden implements TenantVerifierContract {
      constructor(readonly hidden: Hidden) {}
      verify(): VerifiedTenant {
        return ACME;
      }
    }
    const verify = resolveTenantVerifier(
      NeedsHidden,
      (
        await Test.createTestingModule({
          imports: [HiddenModule, DurableModule.forRoot({ connection: 'redis://x' })],
        })
          .overrideProvider(RUN_REDIS_WORKER)
          .useValue(async () => ({ close: async () => {} }))
          .compile()
      ).get(ModuleRef),
    );
    await expect(verify?.({ token: 't' })).rejects.toThrow(
      /could not build NeedsHidden: register it as a provider/,
    );
  });

  it('uses the registered provider instance when the app registers the class', async () => {
    DirectoryVerifier.built = 0;
    const { moduleRef, transport } = await bootOperator(DirectoryVerifier, [DirectoryVerifier]);
    const token = signTenantToken('acme', SECRET);
    await transport.request?.({
      requestId: 'q',
      tenant: token,
      body: { kind: 'listRuns', query: {} },
    });
    expect(transport.replies[0]?.result.ok).toBe(true);
    expect(DirectoryVerifier.built).toBe(1); // the provider itself, not a second instance
    await moduleRef.close();
  });

  it('verifies start-runs with the same resolved verifier (a lazy import here)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn(async () => ({ default: DirectoryVerifier }));
    const { moduleRef, transport, store } = await bootOperator(load);
    await transport.startRun?.({
      tenant: signTenantToken('acme', SECRET),
      workflow: 'greet',
      input: null,
      runId: 'ok-run',
    });
    await transport.startRun?.({ tenant: 'forged', workflow: 'greet', input: null, runId: 'bad' });
    expect((await store.getRun('ok-run'))?.namespace).toBe('acme');
    expect(await store.getRun('bad')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped a start-run'));
    expect(load).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });

  it('a throwing verifier fails the request and never reaches the gateway', async () => {
    const { moduleRef, transport } = await bootOperator({
      verify: () => {
        throw new Error('idp down');
      },
    });
    const gateway = moduleRef.get(RunGateway);
    const listRuns = vi.spyOn(gateway, 'listRuns');
    await transport.request?.({
      requestId: 'q',
      tenant: 't',
      body: { kind: 'listRuns', query: {} },
    });
    expect(transport.replies).toEqual([
      { requestId: 'q', result: { ok: false, error: { message: 'idp down' } } },
    ]);
    expect(listRuns).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});

describe('DurableModule tenantToken through Nest DI', () => {
  async function bootTenant(tenantToken: DurableModuleOptions['tenantToken']) {
    const requests: RunRequest[] = [];
    const transport = {
      onRunReply: () => {},
      dispatchRunRequest: async (msg: RunRequest) => {
        requests.push(msg);
      },
    } as unknown as Transport;
    const moduleRef = await Test.createTestingModule({
      imports: [
        DirectoryModule,
        DurableModule.forRoot({
          topology: 'tenant',
          partition: 'acme',
          connection: 'redis://x',
          transport,
          runGatewayTimeoutMs: 20,
          ...(tenantToken !== undefined ? { tenantToken } : {}),
        }),
      ],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(async () => ({ close: async () => {} }))
      .compile();
    await moduleRef.init();
    const gateway = moduleRef.get(RunGateway);
    await gateway.listRuns({}).catch(() => undefined);
    await gateway.listRuns({}).catch(() => undefined);
    await moduleRef.close();
    return requests.map((r) => r.tenant);
  }

  it('a class is built through DI and asked for a token per request', async () => {
    const token = signTenantToken('acme', SECRET);
    expect(await bootTenant(DirectoryCredentials)).toEqual([token, token]);
  });

  it('a lazy import is loaded once', async () => {
    const load = vi.fn(async () => ({ default: DirectoryCredentials }));
    expect(await bootTenant(load)).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a string, a function and an object still work', async () => {
    expect(await bootTenant('static')).toEqual(['static', 'static']);
    let n = 0;
    expect(await bootTenant(() => `fn-${++n}`)).toEqual(['fn-1', 'fn-2']);
    expect(await bootTenant({ token: () => 'object' })).toEqual(['object', 'object']);
  });

  it('without a token the partition is sent', async () => {
    expect(await bootTenant(undefined)).toEqual(['acme', 'acme']);
  });

  it('the engine facade resolves the option itself and presents the token on start-run', async () => {
    const sink: unknown[] = [];
    const Queue = class {
      async add(_name: string, data: unknown) {
        sink.push(data);
      }
      async close() {}
    };
    const client = new DurableStartClient(
      {
        topology: 'tenant',
        partition: 'acme',
        connection: 'redis://x',
        tenantToken: { token: () => 'facade-token' },
      },
      { Queue } as never,
    );
    await client.start('greet', null, 'r1');
    expect(sink).toEqual([expect.objectContaining({ tenant: 'facade-token', workflow: 'greet' })]);
  });
});
