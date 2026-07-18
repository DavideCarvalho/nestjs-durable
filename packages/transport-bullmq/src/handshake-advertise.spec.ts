import { descriptorHash } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import {
  BullMQTransport,
  buildWorkerDescriptor,
  parseHeartbeatValue,
} from './bullmq-transport';

/**
 * Handshake advertisement + negotiation wiring (design §7.2/§7.3/§7.4). The BullMQ transport, acting
 * as a worker, advertises a byte-compatible descriptor; acting as a control-plane, it negotiates
 * against a remote worker's descriptor and blocks dispatch when nobody is capable/compatible. These
 * exercise the pure paths (no Redis).
 */

describe('buildWorkerDescriptor — the node worker advertisement (design §7.1)', () => {
  it('builds a well-formed node descriptor from the handled step names', () => {
    const d = buildWorkerDescriptor({
      instanceId: 'ts-billing-01',
      steps: ['Billing.refund', 'Billing.charge'],
      startedAt: 1000,
      partition: 'billing',
      namespace: 'acme',
    });
    expect(d.runtime).toBe('node');
    expect(d.instanceId).toBe('ts-billing-01');
    expect(d.protocol).toEqual({ version: 1, range: [1, 1] });
    // Steps are sorted so the descriptorHash is order-insensitive to registration order.
    expect(d.steps).toEqual(['Billing.charge', 'Billing.refund']);
    expect(d.partition).toBe('billing');
    expect(d.namespace).toBe('acme');
    // Advertises the canonical v1 capability baseline.
    expect(d.capabilities).toContain('saga');
    expect(d.capabilities).toContain('search-attributes');
  });

  it('omits a default namespace (byte-identical to the un-namespaced wire shape)', () => {
    const d = buildWorkerDescriptor({ instanceId: 'i', steps: [], startedAt: 0, namespace: 'default' });
    expect('namespace' in d).toBe(false);
  });

  it('registration order does not change the descriptorHash (sorted projection)', () => {
    const a = buildWorkerDescriptor({ instanceId: 'i', steps: ['a', 'b', 'c'], startedAt: 5 });
    const b = buildWorkerDescriptor({ instanceId: 'i', steps: ['c', 'a', 'b'], startedAt: 5 });
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });
});

describe('parseHeartbeatValue — extracts the two-tier ETag (design §7.2)', () => {
  it('reads descriptorHash off the compact beat', () => {
    const raw = JSON.stringify({
      ts: 1_700_000_000_000,
      status: { concurrency: { mode: 'fixed', limit: 1 }, inFlight: 0 },
      descriptorHash: '44c6793c8eb7089f',
    });
    const parsed = parseHeartbeatValue(raw);
    expect(parsed.lastBeatAt).toBe(1_700_000_000_000);
    expect(parsed.descriptorHash).toBe('44c6793c8eb7089f');
  });

  it('is absent for a legacy beat that carries no ETag', () => {
    const parsed = parseHeartbeatValue(JSON.stringify({ ts: 1_700_000_000_000 }));
    expect(parsed.descriptorHash).toBeUndefined();
  });
});

describe('negotiateWith — control-plane bilateral negotiation (design §7.3/§7.4)', () => {
  const transport = new BullMQTransport({ connection: {}, instanceId: 'cp-1' });

  it('is compatible with a v1 node worker advertising the same capabilities', () => {
    const remote = buildWorkerDescriptor({
      instanceId: 'w1',
      steps: ['Billing.charge'],
      startedAt: 1,
    });
    const r = transport.negotiateWith(remote);
    expect(r.outcome).toBe('compatible');
    expect(r.negotiatedProtocol).toBe(1);
  });

  it('is INCOMPATIBLE with a worker that only speaks protocol v2', () => {
    const r = transport.negotiateWith({
      instanceId: 'w2',
      runtime: 'node',
      protocol: { version: 2, range: [2, 2] },
      capabilities: ['saga'],
    });
    expect(r.outcome).toBe('incompatible');
    expect(r.reason?.code).toBe('protocol.incompatible');
  });

  it('a legacy worker (no descriptor fields) negotiates as compatible v1', () => {
    const r = transport.negotiateWith({ instanceId: 'old', runtime: 'python' });
    expect(r.outcome).toBe('compatible');
  });

  it('degrades when the caller requires a capability the remote lacks', () => {
    const remote = buildWorkerDescriptor({ instanceId: 'w3', steps: [], startedAt: 1 });
    const r = transport.negotiateWith(remote, ['search-attr-v2']);
    expect(r.outcome).toBe('degraded');
    expect(r.reason?.detail.missingRequired).toEqual(['search-attr-v2']);
  });
});
