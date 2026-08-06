import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROTOCOL_VERSION,
  LEGACY_V1_CAPABILITIES,
  LEGACY_V1_PROTOCOL,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
  type WorkflowRegistration,
  describeWorker,
  descriptorHash,
  heartbeatStatus,
  isLegacyDescriptor,
  normalizeDescriptor,
} from './descriptor';

/** A fully-specified modern descriptor. */
function makeDescriptor(overrides: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    instanceId: 'ts-a-1',
    runtime: 'node',
    sdk: { name: '@adonis-agora/durable', version: '1.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: ['saga', 'signals'],
    workflows: ['CheckoutWorkflow'],
    steps: ['Billing.charge'],
    startedAt: 1000,
    ...overrides,
  };
}

describe('descriptorHash — stability + sensitivity', () => {
  it('is order-insensitive over the set-valued fields (same members, any order → same hash)', () => {
    const a = makeDescriptor({
      capabilities: ['saga', 'signals', 'priority'],
      workflows: ['A', 'B', 'C'],
      steps: ['x', 'y'],
    });
    const b = makeDescriptor({
      capabilities: ['priority', 'saga', 'signals'],
      workflows: ['C', 'A', 'B'],
      steps: ['y', 'x'],
    });
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });

  it('is insensitive to object key insertion order', () => {
    const a = makeDescriptor();
    // Rebuild with keys in a different insertion order.
    const b: WorkerDescriptor = {
      startedAt: a.startedAt,
      steps: a.steps,
      workflows: a.workflows,
      capabilities: a.capabilities,
      protocol: a.protocol,
      sdk: a.sdk,
      runtime: a.runtime,
      instanceId: a.instanceId,
    };
    expect(descriptorHash(b)).toBe(descriptorHash(a));
  });

  it('de-duplicates set members (a repeated capability does not change the hash)', () => {
    const base = makeDescriptor({ capabilities: ['saga', 'signals'] });
    const dup = makeDescriptor({ capabilities: ['saga', 'signals', 'saga'] });
    expect(descriptorHash(dup)).toBe(descriptorHash(base));
  });

  // --- Sensitivity: mutating ANY content-bearing field changes the hash (mutation proof). ---
  it('changes when a capability is added', () => {
    expect(
      descriptorHash(makeDescriptor({ capabilities: ['saga', 'signals', 'priority'] })),
    ).not.toBe(descriptorHash(makeDescriptor()));
  });

  it('changes when a workflow changes', () => {
    expect(descriptorHash(makeDescriptor({ workflows: ['Other'] }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when a step changes', () => {
    expect(descriptorHash(makeDescriptor({ steps: ['Billing.refund'] }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when startedAt changes (a restart triggers a re-read)', () => {
    expect(descriptorHash(makeDescriptor({ startedAt: 2000 }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when the protocol range changes', () => {
    expect(descriptorHash(makeDescriptor({ protocol: { version: 2, range: [1, 2] } }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when partition/namespace change (present-vs-absent are distinct)', () => {
    const withPartition = descriptorHash(makeDescriptor({ partition: 'p1' }));
    const withoutPartition = descriptorHash(makeDescriptor());
    expect(withPartition).not.toBe(withoutPartition);
  });

  it('produces a 16-char lowercase hex string', () => {
    expect(descriptorHash(makeDescriptor())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizeDescriptor — legacy-v1 backward-compat (design §7.7)', () => {
  it('defaults an absent protocol to the legacy v1 baseline', () => {
    const raw: RawWorkerDescriptor = { instanceId: 'legacy-1', runtime: 'python' };
    expect(normalizeDescriptor(raw).protocol).toEqual(LEGACY_V1_PROTOCOL);
  });

  it('defaults an absent capabilities field to the v1 baseline set', () => {
    const raw: RawWorkerDescriptor = { instanceId: 'legacy-1', runtime: 'python' };
    expect(normalizeDescriptor(raw).capabilities).toEqual([...LEGACY_V1_CAPABILITIES]);
  });

  it('PRESERVES an explicit empty capabilities array (modern SDK that advertises nothing)', () => {
    const raw: RawWorkerDescriptor = {
      instanceId: 'modern-1',
      runtime: 'node',
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
    };
    expect(normalizeDescriptor(raw).capabilities).toEqual([]);
  });

  it('defaults workflows/steps/sdk/startedAt on a bare descriptor', () => {
    const n = normalizeDescriptor({ instanceId: 'legacy-1', runtime: 'python' });
    expect(n.workflows).toEqual([]);
    expect(n.steps).toEqual([]);
    expect(n.sdk).toEqual({ name: 'unknown', version: '0' });
    expect(n.startedAt).toBe(0);
  });

  it('leaves a fully-specified descriptor untouched', () => {
    const d = makeDescriptor({ partition: 'p', namespace: 'n' });
    expect(normalizeDescriptor(d)).toEqual(d);
  });
});

describe('isLegacyDescriptor', () => {
  it('is true when protocol is absent', () => {
    expect(isLegacyDescriptor({ instanceId: 'x', runtime: 'node' })).toBe(true);
  });
  it('is false once protocol is present', () => {
    expect(isLegacyDescriptor(makeDescriptor())).toBe(false);
  });
});

describe('heartbeatStatus — two-tier advertisement (design §7.2)', () => {
  it('stamps the descriptor ETag and defaults status/ts', () => {
    const d = makeDescriptor();
    const hb = heartbeatStatus(d, { ts: 5 });
    expect(hb).toEqual({ ts: 5, status: 'up', descriptorHash: descriptorHash(d) });
  });

  it('carries an explicit lifecycle status', () => {
    const hb = heartbeatStatus(makeDescriptor(), { ts: 5, status: 'draining' });
    expect(hb.status).toBe('draining');
  });

  it('the ETag tracks descriptor changes (different descriptor → different hash on the beat)', () => {
    const a = heartbeatStatus(makeDescriptor(), { ts: 1 });
    const b = heartbeatStatus(makeDescriptor({ capabilities: ['saga'] }), { ts: 1 });
    expect(a.descriptorHash).not.toBe(b.descriptorHash);
  });
});

describe('constants', () => {
  it('exposes the current protocol version as v1', () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(1);
  });

  it('LEGACY_V1_CAPABILITIES is the frozen canonical v1 baseline (cross-SDK contract)', () => {
    // The exact list the adonis + python SDKs MUST also ship. Locking it here makes any drift a
    // failing test rather than a silent polyglot-interop break.
    expect([...LEGACY_V1_CAPABILITIES]).toEqual([
      'saga',
      'signals',
      'search-attributes',
      'priority',
      'entities',
      'child-workflows',
      'singleton',
      'schedules',
      'continue-as-new',
      'queries',
      'cancellation',
    ]);
    expect(Object.isFrozen(LEGACY_V1_CAPABILITIES)).toBe(true);
  });
});

describe('registrations — the announcement rides the descriptor (design §7.9)', () => {
  it('leaves the hash of a descriptor that announces nothing BYTE-identical to before the field', () => {
    // The pinned cross-language hash of the golden fixture is computed by SDKs that predate
    // `registrations`; the conditional key is what keeps every already-published ETag valid.
    const bare = makeDescriptor();
    expect(descriptorHash({ ...bare, registrations: undefined })).toBe(descriptorHash(bare));
  });

  it('changes the hash when the announcement changes (an ETag a control plane can trust)', () => {
    const bare = makeDescriptor();
    const announcing = makeDescriptor({ registrations: [{ name: 'pipeline', version: '1' }] });
    expect(descriptorHash(announcing)).not.toBe(descriptorHash(bare));
    expect(
      descriptorHash(makeDescriptor({ registrations: [{ name: 'pipeline', version: '2' }] })),
    ).not.toBe(descriptorHash(announcing));
  });

  it('is order-insensitive across announcements AND within a `requires` set', () => {
    const a = makeDescriptor({
      registrations: [
        { name: 'b', requires: ['saga', 'signals'] },
        { name: 'a', group: 'a@acme' },
      ],
    });
    const b = makeDescriptor({
      registrations: [
        { name: 'a', group: 'a@acme' },
        { name: 'b', requires: ['signals', 'saga'] },
      ],
    });
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });

  it('distinguishes an un-stated field from a stated one (absence is not a value)', () => {
    const unstated = makeDescriptor({ registrations: [{ name: 'pipeline' }] });
    const stated = makeDescriptor({ registrations: [{ name: 'pipeline', group: 'pipeline' }] });
    expect(descriptorHash(stated)).not.toBe(descriptorHash(unstated));
  });

  it('normalizeDescriptor keeps absent absent — it never defaults to an empty announcement', () => {
    expect(normalizeDescriptor(makeDescriptor())).not.toHaveProperty('registrations');
    expect(normalizeDescriptor(makeDescriptor({ registrations: [] })).registrations).toEqual([]);
  });
});

describe('describeWorker — the one builder both TS advertisers publish through', () => {
  it('sorts the set-valued fields so registration ORDER cannot change the published bytes', () => {
    const a = describeWorker({
      instanceId: 'i',
      runtime: 'node',
      sdk: { name: 'sdk', version: '1' },
      steps: ['c', 'a'],
      workflows: ['z', 'b'],
      startedAt: 5,
    });
    expect(a.steps).toEqual(['a', 'c']);
    expect(a.workflows).toEqual(['b', 'z']);
    expect(a.protocol).toEqual({ version: CURRENT_PROTOCOL_VERSION, range: [1, 1] });
    expect(a.capabilities).toEqual([...LEGACY_V1_CAPABILITIES]);
  });

  it('omits an empty announcement, a `default` namespace and an unset partition', () => {
    const d = describeWorker({
      instanceId: 'i',
      runtime: 'python',
      sdk: { name: 'sdk', version: '1' },
      steps: [],
      registrations: [],
      namespace: 'default',
      startedAt: 0,
    });
    expect('registrations' in d).toBe(false);
    expect('namespace' in d).toBe(false);
    expect('partition' in d).toBe(false);
  });

  it('orders announcements by name@version, so two replicas publish identical bytes', () => {
    const of = (registrations: WorkflowRegistration[]) =>
      describeWorker({
        instanceId: 'i',
        runtime: 'node',
        sdk: { name: 'sdk', version: '1' },
        steps: [],
        registrations,
        startedAt: 0,
      });
    const one = of([
      { name: 'pipeline', version: '2' },
      { name: 'extraction', version: '1' },
    ]);
    const two = of([
      { name: 'extraction', version: '1' },
      { name: 'pipeline', version: '2' },
    ]);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.registrations?.map((r) => r.name)).toEqual(['extraction', 'pipeline']);
  });
});
