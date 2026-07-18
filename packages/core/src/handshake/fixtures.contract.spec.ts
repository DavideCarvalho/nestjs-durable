import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type HeartbeatStatus,
  type WorkerDescriptor,
  descriptorHash,
} from './descriptor';

/**
 * Cross-SDK contract test (design §7.8). These golden fixtures are the polyglot wire contract: the
 * adonis, nestjs and python SDKs must each serialize to and parse from these EXACT bytes. Here the
 * nestjs (aviary) side asserts it round-trips them byte-identically, that the descriptorHash matches
 * the value the adonis + python SDKs also compute (`44c6793c8eb7089f`), and that the heartbeat ETag
 * matches the descriptor it advertises.
 *
 * The fixtures live at the repo root (`<repo>/fixtures/wire/`) — a single shared location all three
 * SDKs read from — so `descriptor.json` is literally the same bytes the Python `test_handshake.py`
 * and the Adonis `fixtures.contract.spec.ts` read.
 */

// packages/core/src/handshake/ → repo root is four levels up.
const wireDir = fileURLToPath(new URL('../../../../fixtures/wire/', import.meta.url));
const readRaw = (name: string): string => readFileSync(`${wireDir}${name}`, 'utf8');

/** The golden hash pinned by the design spec + Appendix B — identical across TS/Python/Adonis. */
const GOLDEN_DESCRIPTOR_HASH = '44c6793c8eb7089f';

describe('golden fixture: descriptor.json', () => {
  const raw = readRaw('descriptor.json');
  const parsed = JSON.parse(raw) as WorkerDescriptor;

  it('parses into a well-formed WorkerDescriptor', () => {
    expect(parsed.instanceId).toBe('ts-billing-01-4821');
    expect(parsed.runtime).toBe('node');
    expect(parsed.protocol).toEqual({ version: 1, range: [1, 1] });
    expect(parsed.capabilities).toContain('search-attr-v2');
    expect(parsed.workflows).toEqual(['CheckoutWorkflow', 'RefundWorkflow']);
  });

  it('round-trips byte-identically (serialize(parse(bytes)) === bytes)', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });

  it('computes the pinned cross-language descriptorHash (44c6793c8eb7089f)', () => {
    expect(descriptorHash(parsed)).toBe(GOLDEN_DESCRIPTOR_HASH);
  });
});

describe('golden fixture: heartbeat-status.json (two-tier ETag)', () => {
  const raw = readRaw('heartbeat-status.json');
  const parsed = JSON.parse(raw) as HeartbeatStatus;

  it('parses into a well-formed HeartbeatStatus', () => {
    expect(parsed.status).toBe('up');
    expect(parsed.ts).toBe(1752710460000);
    expect(parsed.descriptorHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trips byte-identically', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });

  it("its descriptorHash equals the descriptor fixture's computed hash (the ETag contract)", () => {
    const descriptor = JSON.parse(readRaw('descriptor.json')) as WorkerDescriptor;
    expect(parsed.descriptorHash).toBe(descriptorHash(descriptor));
    expect(parsed.descriptorHash).toBe(GOLDEN_DESCRIPTOR_HASH);
  });
});
