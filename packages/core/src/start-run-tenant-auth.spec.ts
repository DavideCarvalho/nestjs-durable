import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, StartRunMessage, StepResult, Transport } from './interfaces';
import { grantsClientTenant, hmacTenantVerifier, signTenantToken } from './tenant-auth';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const SECRET = 'start-run-secret';

class StartRunTransport implements Transport {
  private handler?: (message: StartRunMessage) => Promise<void>;
  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  onStartRun(handler: (message: StartRunMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async deliver(message: StartRunMessage): Promise<void> {
    if (!this.handler) throw new Error('no onStartRun handler was registered');
    await this.handler(message);
  }
}

function setup(
  verifyTenant?: Parameters<typeof hmacTenantVerifier>[0] | 'throws',
  capabilities?: string[],
) {
  const store = new InMemoryStateStore();
  const transport = new StartRunTransport();
  const engine = new WorkflowEngine({
    store,
    transport,
    namespace: 'control-plane',
    verifyTenant:
      verifyTenant === 'throws'
        ? () => {
            throw new Error('verifier down');
          }
        : verifyTenant !== undefined
          ? hmacTenantVerifier(verifyTenant, capabilities)
          : undefined,
  });
  engine.register('processing', '1', async (_ctx, input) => input);
  return { store, transport };
}

describe('WorkflowEngine — start-run tenant verification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives the run namespace from a verified token, ignoring the wire claim', async () => {
    const { store, transport } = setup(SECRET);
    await transport.deliver({
      tenant: signTenantToken('acme', SECRET),
      workflow: 'processing',
      input: {},
    });
    const runs = await store.listRuns({});
    expect(runs.map((r) => r.namespace)).toEqual(['acme']);
  });

  it('creates nothing for a missing, tampered or foreign-secret token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, transport } = setup(SECRET);
    const sig = signTenantToken('acme', SECRET).split('.').pop();
    for (const tenant of ['acme', `evil.${sig}`, signTenantToken('acme', 'other')]) {
      await transport.deliver({ tenant, workflow: 'processing', input: {} });
    }
    expect(await store.listRuns({})).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('a throwing verifier drops the start instead of failing the consumer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, transport } = setup('throws');
    await expect(
      transport.deliver({ tenant: 'acme', workflow: 'processing', input: {} }),
    ).resolves.toBeUndefined();
    expect(await store.listRuns({})).toHaveLength(0);
  });

  it('without a verifier the wire tenant is trusted verbatim (unchanged behaviour)', async () => {
    const { store, transport } = setup();
    await transport.deliver({ tenant: 'acme', workflow: 'processing', input: {} });
    expect((await store.listRuns({}))[0]?.namespace).toBe('acme');
  });
});

describe('WorkflowEngine — a customer tenant claimed on a start-run (A4)', () => {
  const claim = (tenantId: string) => ({
    tenant: signTenantToken('acme', SECRET),
    workflow: 'processing',
    input: {},
    tenantId,
    tenantKind: 'organization',
  });

  it('keeps the claim when the verified token grants tenancy:* or tenancy:<id>', async () => {
    for (const grant of ['tenancy:*', 'tenancy:org_1']) {
      const { store, transport } = setup(SECRET, [grant]);
      await transport.deliver(claim('org_1'));
      const [run] = await store.listRuns({});
      expect(run).toMatchObject({
        namespace: 'acme',
        tenantId: 'org_1',
        tenantKind: 'organization',
      });
    }
  });

  it('drops the claim (the run gets no customer tenant) without a matching capability', async () => {
    for (const capabilities of [undefined, ['gpu'], ['tenancy:org_2']]) {
      const { store, transport } = setup(SECRET, capabilities);
      await transport.deliver(claim('org_1'));
      const [run] = await store.listRuns({});
      expect(run?.namespace).toBe('acme');
      expect(run?.tenantId ?? null).toBeNull();
    }
  });

  it('never trusts a claim from an unverified process', async () => {
    const { store, transport } = setup();
    await transport.deliver({ ...claim('org_1'), tenant: 'acme' });
    expect((await store.listRuns({}))[0]?.tenantId ?? null).toBeNull();
  });

  it('grantsClientTenant reads only the tenancy capabilities', () => {
    expect(grantsClientTenant({ tenant: 'a', capabilities: ['tenancy:*'] }, 'x')).toBe(true);
    expect(grantsClientTenant({ tenant: 'a', capabilities: ['tenancy:x'] }, 'x')).toBe(true);
    expect(grantsClientTenant({ tenant: 'a', capabilities: ['tenancy:y'] }, 'x')).toBe(false);
    expect(grantsClientTenant({ tenant: 'a' }, 'x')).toBe(false);
    expect(grantsClientTenant(null, 'x')).toBe(false);
  });
});
