/**
 * The worker registry: which instance serves which routing token (worker heartbeats), what it
 * advertises (handshake descriptors) and which instances consume a run queue.
 *
 * CROSS-SDK CONTRACT, byte-compatible with the AdonisJS durable lib (`@agora/durable`, the
 * `workerRegistry` of its BullMQ transport) so both fleets on one Redis read each other:
 *
 * - `${P}-workers:instances` — ONE hash per prefix, one field per writing transport
 *   (`<instanceId>#<nonce>`), whose value lists every token that instance serves, grouped by value:
 *   `{ v: 1, instance, expiresAt, heartbeats: [{ value, expiresAt, tokens }], descriptors: [...] }`.
 *   A writer rewrites its field once per beat whatever its token count; a reader does ONE `HGETALL`.
 *   The hash carries a TTL and every writer deletes other writers' expired fields (a crashed process).
 * - Kept for older readers while `legacyWrites` is on, refreshed every `legacyWriteIntervalMs`:
 *   the per-instance keys `${P}-worker-heartbeat:<token>:<instance>` /
 *   `${P}-worker-descriptor:<token>:<instance>` (what the NestJS / Python SDKs read and wrote before),
 *   and the per-token hashes `${P}-workers:<heartbeats|descriptors>:<token>` (field = instance, value
 *   `{ expiresAt, value }`) indexed by the sorted set `${P}-workers:tokens` (score = expiry, ms).
 * - Per-instance keys of writers that never write the hash (an older version, the Python SDK) are
 *   read by ONE `SCAN` walk shared by every reader of the process, at most once per
 *   `legacyScanIntervalMs`, while `legacyScan` is on.
 *
 * `runConsumers` (the engines consuming a run queue, see `onDispatchedRun`) ride the same field under
 * a key of their own. Other SDKs ignore it, so a run consumer never reads as a worker heartbeat, which
 * would make convention routing dispatch to a task queue nobody consumes.
 */

/** The kinds the hash field lists. `heartbeats` and `descriptors` are the cross-SDK ones. */
export type WorkerRegistryKind = 'heartbeats' | 'descriptors' | 'runConsumers';

/** Options of the registry (the `workerRegistry` option of the transport). */
export interface WorkerRegistryOptions {
  /**
   * Also read the per-instance keys that writers without the instances hash write (this package
   * before this version, the Python SDK, `@dudousxd/durable-worker` before this version, AdonisJS
   * 1.0.0-rc.31 and older), with ONE SCAN walk shared by every reader in the process and run at most
   * once per {@link legacyScanIntervalMs}. Turn it off once every writer sharing the Redis writes the
   * instances hash. Default `true`.
   */
  legacyScan?: boolean | undefined;
  /** The least time (ms) between two compatibility walks. Default `60_000`. */
  legacyScanIntervalMs?: number | undefined;
  /**
   * Also write what older readers read: each token's per-instance key and its field in the per-token
   * hash, once per {@link legacyWriteIntervalMs} (they live three intervals). Turn it off once every
   * reader sharing the Redis runs this version; that leaves one `HSET` per instance per beat.
   * Default `true`.
   */
  legacyWrites?: boolean | undefined;
  /** How often (ms) the keys of {@link legacyWrites} are refreshed. Default `30_000`. */
  legacyWriteIntervalMs?: number | undefined;
}

/** The Redis commands the registry uses. ioredis has them all; a client without the hash ones
 *  (a minimal fake) gets the per-instance keys alone, written every beat and walked every read. */
export interface RegistryRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget?(...keys: string[]): Promise<(string | null)[]>;
  get?(key: string): Promise<string | null>;
  hset?(key: string, field: string, value: string): Promise<number>;
  hgetall?(key: string): Promise<Record<string, string>>;
  hdel?(key: string, ...fields: string[]): Promise<number>;
  pexpire?(key: string, ms: number): Promise<number>;
  zadd?(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore?(key: string, min: string | number, max: string | number): Promise<number>;
}

type HashRedis = Required<RegistryRedis>;

/** One registry entry: its routing token, its instance id and its raw value. `instance` is `''` for a
 *  per-instance key without an instance segment. `expiresAt` is set for an entry of a hash. */
export interface RegistryEntry {
  token: string;
  instance: string;
  raw: string;
  expiresAt?: number | undefined;
}

export type RegistrySnapshot = Record<WorkerRegistryKind, RegistryEntry[]>;

const KINDS: readonly WorkerRegistryKind[] = ['heartbeats', 'descriptors', 'runConsumers'];

function emptySnapshot(): RegistrySnapshot {
  return { heartbeats: [], descriptors: [], runConsumers: [] };
}

// --- names (cross-SDK) -----------------------------------------------------------------------

/** `${P}-workers:instances` — the registry hash. */
export function workerInstancesKey(effPrefix: string): string {
  return `${effPrefix}-workers:instances`;
}

/** `${P}-workers:<kind>:<token>` — the per-token hash older AdonisJS readers read. */
export function workerRegistryHashKey(
  effPrefix: string,
  kind: 'heartbeats' | 'descriptors',
  token: string,
): string {
  return `${effPrefix}-workers:${kind}:${token}`;
}

/** `${P}-workers:tokens` — sorted set of the tokens with a per-token hash (score = expiry, ms). */
export function workerRegistryIndexKey(effPrefix: string): string {
  return `${effPrefix}-workers:tokens`;
}

export function workerHeartbeatKey(effPrefix: string, token: string, instance: string): string {
  return `${effPrefix}-worker-heartbeat:${token}:${instance}`;
}

export function workerDescriptorKey(effPrefix: string, token: string, instance: string): string {
  return `${effPrefix}-worker-descriptor:${token}:${instance}`;
}

/** `<runs queue>-consumer:<instance>` — a run consumer's per-instance key (its token is the queue). */
export function runConsumerKey(runsQueue: string, instance: string): string {
  return `${runsQueue}-consumer:${instance}`;
}

/** The per-instance key older readers read for an entry. */
function perInstanceKey(
  effPrefix: string,
  kind: WorkerRegistryKind,
  token: string,
  instance: string,
): string {
  if (kind === 'heartbeats') return workerHeartbeatKey(effPrefix, token, instance);
  if (kind === 'descriptors') return workerDescriptorKey(effPrefix, token, instance);
  return runConsumerKey(token, instance);
}

// --- the hash field ----------------------------------------------------------------------------

/** Version of the field layout; a reader skips a field of a version it does not know. */
const INSTANCE_RECORD_VERSION = 1;

export interface InstanceRecordGroup {
  value: string;
  expiresAt: number;
  tokens: string[];
}

/** One field of the instances hash. `expiresAt` is its latest entry's, for pruning. */
export interface InstanceRecord {
  v: number;
  instance: string;
  expiresAt: number;
  heartbeats: InstanceRecordGroup[];
  descriptors: InstanceRecordGroup[];
  runConsumers?: InstanceRecordGroup[] | undefined;
}

/** An entry this process advertises. */
export interface OwnEntry {
  instance: string;
  kind: WorkerRegistryKind;
  token: string;
  value: string;
  expiresAt: number;
}

/** Encode one instance's entries as its field value, grouping entries that share a value. */
export function encodeInstanceRecord(entries: readonly OwnEntry[]): string {
  const record: InstanceRecord = {
    v: INSTANCE_RECORD_VERSION,
    instance: entries[0]?.instance ?? '',
    expiresAt: 0,
    heartbeats: [],
    descriptors: [],
  };
  const groups = new Map<string, InstanceRecordGroup>();
  for (const entry of entries) {
    record.expiresAt = Math.max(record.expiresAt, entry.expiresAt);
    const id = `${entry.kind}\n${entry.value}`;
    let group = groups.get(id);
    if (!group) {
      group = { value: entry.value, expiresAt: entry.expiresAt, tokens: [] };
      groups.set(id, group);
      if (entry.kind === 'runConsumers') {
        record.runConsumers ??= [];
        record.runConsumers.push(group);
      } else {
        record[entry.kind].push(group);
      }
    }
    group.expiresAt = Math.max(group.expiresAt, entry.expiresAt);
    group.tokens.push(entry.token);
  }
  return JSON.stringify(record);
}

/** A field of the instances hash, or `undefined` when malformed or of an unknown version. */
export function decodeInstanceRecord(raw: string): InstanceRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceRecord>;
    if (
      parsed.v !== INSTANCE_RECORD_VERSION ||
      typeof parsed.instance !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      !Array.isArray(parsed.heartbeats) ||
      !Array.isArray(parsed.descriptors)
    ) {
      return undefined;
    }
    return parsed as InstanceRecord;
  } catch {
    return undefined;
  }
}

/** The entries of the instances hash, skipping fields ending with `ownSuffix` (read from memory)
 *  and malformed ones, newest field first (an instance restarted under the same id wins). */
export function decodeInstancesHash(
  fields: Record<string, string>,
  ownSuffix: string,
): RegistrySnapshot {
  const out = emptySnapshot();
  const records = Object.entries(fields)
    .filter(([field]) => !field.endsWith(ownSuffix))
    .map(([, raw]) => decodeInstanceRecord(raw))
    .filter((r): r is InstanceRecord => r !== undefined)
    .sort((a, b) => b.expiresAt - a.expiresAt);
  for (const record of records) {
    for (const kind of KINDS) {
      const groups = record[kind];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (typeof group?.value !== 'string' || !Array.isArray(group.tokens)) continue;
        for (const token of group.tokens) {
          if (typeof token !== 'string') continue;
          out[kind].push({
            token,
            instance: record.instance,
            raw: group.value,
            expiresAt: typeof group.expiresAt === 'number' ? group.expiresAt : record.expiresAt,
          });
        }
      }
    }
  }
  return out;
}

/** The value of a per-token hash field still live at `now`, else `undefined`. */
function liveRegistryValue(stored: string, now: number): string | undefined {
  try {
    const parsed = JSON.parse(stored) as { expiresAt?: unknown; value?: unknown };
    if (typeof parsed.expiresAt !== 'number' || typeof parsed.value !== 'string') return undefined;
    return parsed.expiresAt > now ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/** `primary`, then each `rest` entry of a (token, instance) `primary` lacks that `keep` accepts. */
function mergeEntries(
  primary: RegistryEntry[],
  rest: RegistryEntry[],
  keep?: (entry: RegistryEntry) => boolean,
): RegistryEntry[] {
  const seen = new Set(primary.map((e) => `${e.token}\n${e.instance}`));
  const out = [...primary];
  for (const entry of rest) {
    const id = `${entry.token}\n${entry.instance}`;
    if (seen.has(id) || (keep && !keep(entry))) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

// --- tuning ----------------------------------------------------------------------------------

/** How long the instances-hash read is reused by every reader of a process (`fresh` skips it). */
export const REGISTRY_READ_MAX_AGE_MS = 30_000;
/** How long a walk is reused when it is the whole read (a client without hash commands). */
export const WORKER_HEARTBEAT_READ_TTL_MS = 5_000;
const DEFAULT_LEGACY_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_LEGACY_WRITE_INTERVAL_MS = 30_000;
/** How long the instances hash outlives the last upkeep of a writer; fields carry their own expiry. */
const INSTANCES_KEY_TTL_MS = 10 * 60_000;
/** How often a writer refreshes the instances hash's TTL and deletes expired fields. */
const INSTANCES_UPKEEP_MS = 5 * 60_000;
/** How long a per-token hash, and its index entry, outlive the last upkeep of a writer. */
const LEGACY_HASH_TTL_MS = 30 * 60_000;
const LEGACY_HASH_UPKEEP_MS = 10 * 60_000;
const LEGACY_HASH_PRUNE_MS = 30 * 60_000;
/** `COUNT` of the throttled compatibility walk: one SCAN call is one command whatever it visits. */
const LEGACY_SCAN_COUNT = 10_000;
/** `COUNT` of the walk when it is the whole read. */
const SCAN_COUNT = 1_000;

function positiveMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function ownKey(instance: string, kind: WorkerRegistryKind, token: string): string {
  return `${instance}\n${kind}\n${token}`;
}

/** How long a walked (per-instance key) heartbeat is trusted after its `ts`. */
export type WalkedBeatAge = (raw: string) => number;

/** A cached walk, keyed by its MATCH pattern. */
interface WalkSlot {
  at: number | undefined;
  snapshot: RegistrySnapshot | undefined;
  inFlight: Promise<RegistrySnapshot> | undefined;
}

export interface WorkerRegistryDeps {
  /** The effective prefix (namespace folded in). */
  effPrefix: string;
  /** The client the per-instance keys are written to and walked on. */
  keys: () => RegistryRedis;
  /** The client the hashes live on (`workerRegistry.connection`, else {@link keys}). */
  hashes: () => RegistryRedis;
  /** A per-process suffix for this writer's fields. */
  nonce: string;
  /** The epoch ms a walked value was beaten at (0 = unknown), to drop walked keys that went stale. */
  beatAt: (raw: string) => number;
  /** How long a beat is live (the per-instance keys' TTL), ms. */
  beatTtlMs: number;
  onError: (err: unknown) => void;
  options?: WorkerRegistryOptions | undefined;
}

/**
 * One transport's view of, and contribution to, the worker registry. Writes are batched per
 * macrotask into one `HSET` of this writer's field; reads share one `HGETALL` per
 * {@link REGISTRY_READ_MAX_AGE_MS} plus the throttled compatibility walk.
 */
export class WorkerRegistry {
  readonly #deps: WorkerRegistryDeps;
  readonly #legacyScan: boolean;
  readonly #legacyScanIntervalMs: number;
  readonly #legacyWrites: boolean;
  readonly #legacyWriteIntervalMs: number;
  readonly #own = new Map<string, OwnEntry>();
  #flushing: Promise<void> | undefined;
  /** The instances-hash fields this writer wrote (removed on close). */
  readonly #writtenFields = new Set<string>();
  #instancesUpkeepAt: number | undefined;
  #snapshot: { at: number; entries: RegistrySnapshot } | undefined;
  #snapshotRead: Promise<RegistrySnapshot> | undefined;
  readonly #legacyWrittenAt = new Map<string, { at: number; value: string }>();
  readonly #legacyHashUpkeepAt = new Map<string, { at: number; prunedAt: number }>();
  readonly #walks = new Map<string, WalkSlot>();

  constructor(deps: WorkerRegistryDeps) {
    this.#deps = deps;
    const o = deps.options ?? {};
    this.#legacyScan = o.legacyScan !== false;
    this.#legacyScanIntervalMs = positiveMs(
      o.legacyScanIntervalMs,
      DEFAULT_LEGACY_SCAN_INTERVAL_MS,
    );
    this.#legacyWrites = o.legacyWrites !== false;
    this.#legacyWriteIntervalMs = positiveMs(
      o.legacyWriteIntervalMs,
      DEFAULT_LEGACY_WRITE_INTERVAL_MS,
    );
  }

  /** Whether the hash client has the commands the hashes need. */
  hashesSupported(): boolean {
    const c = this.#deps.hashes();
    return (
      typeof c.hset === 'function' &&
      typeof c.hgetall === 'function' &&
      typeof c.hdel === 'function' &&
      typeof c.pexpire === 'function' &&
      typeof c.zadd === 'function' &&
      typeof c.zremrangebyscore === 'function'
    );
  }

  // --- write side ----------------------------------------------------------------------------

  /**
   * Advertise `value` for every token of `tokens` under `kind`, live `ttlSeconds`: one `HSET` of
   * this writer's field (on the next macrotask, shared with the other writes of the same beat), plus
   * the keys older readers read when due ({@link legacyWrites}). `force` writes those at once.
   */
  async advertise(w: {
    instance: string;
    kind: WorkerRegistryKind;
    tokens: readonly string[];
    value: string;
    ttlSeconds: number;
    force?: boolean | undefined;
  }): Promise<void> {
    const expiresAt = Date.now() + w.ttlSeconds * 1000;
    for (const token of w.tokens) {
      this.#own.set(ownKey(w.instance, w.kind, token), {
        instance: w.instance,
        kind: w.kind,
        token,
        value: w.value,
        expiresAt,
      });
    }
    await Promise.all([this.#scheduleFlush(), this.#writeLegacy(w)]);
  }

  /** Stop advertising these tokens of `kind` (their per-instance keys are deleted too). */
  async withdraw(
    instance: string,
    kind: WorkerRegistryKind,
    tokens: readonly string[],
  ): Promise<void> {
    const prefix = this.#deps.effPrefix;
    // Only what this writer wrote for older readers is deleted (the per-instance key and the
    // per-token hash field are written together), so a writer with `legacyWrites` off never touches
    // the keys connection.
    const written: { key: string; token: string }[] = [];
    for (const token of tokens) {
      this.#own.delete(ownKey(instance, kind, token));
      const key = perInstanceKey(prefix, kind, token, instance);
      if (this.#legacyWrittenAt.delete(key)) written.push({ key, token });
      this.#forgetWalked(kind, token, instance);
    }
    const removals: Promise<unknown>[] = [this.#scheduleFlush()];
    if (written.length > 0) removals.push(this.#deps.keys().del(...written.map((w) => w.key)));
    if (written.length > 0 && kind !== 'runConsumers' && this.hashesSupported()) {
      const client = this.#deps.hashes() as HashRedis;
      for (const { token } of written) {
        removals.push(client.hdel(workerRegistryHashKey(prefix, kind, token), instance));
      }
    }
    await Promise.all(removals);
  }

  /** Graceful shutdown: drop every field and key this writer wrote, so readers see it leave now. */
  async removeAll(): Promise<void> {
    const byKind = new Map<
      string,
      { instance: string; kind: WorkerRegistryKind; tokens: string[] }
    >();
    for (const e of this.#own.values()) {
      const id = `${e.instance}\n${e.kind}`;
      const slot = byKind.get(id) ?? { instance: e.instance, kind: e.kind, tokens: [] };
      slot.tokens.push(e.token);
      byKind.set(id, slot);
    }
    this.#own.clear();
    const removals: Promise<unknown>[] = [];
    for (const { instance, kind, tokens } of byKind.values()) {
      removals.push(this.withdraw(instance, kind, tokens));
    }
    if (this.hashesSupported() && this.#writtenFields.size > 0) {
      const client = this.#deps.hashes() as HashRedis;
      removals.push(client.hdel(workerInstancesKey(this.#deps.effPrefix), ...this.#writtenFields));
      this.#writtenFields.clear();
    }
    await Promise.allSettled(removals);
  }

  #scheduleFlush(): Promise<void> {
    if (!this.#flushing) {
      this.#flushing = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          this.#flushing = undefined;
          this.#flush().then(resolve, reject);
        });
      });
    }
    return this.#flushing;
  }

  /**
   * Write every field this writer owns, one per instance, each listing its live entries grouped by
   * value. A field left with no entry is removed. Every {@link INSTANCES_UPKEEP_MS} the hash also gets
   * its TTL refreshed and other writers' expired fields deleted.
   */
  async #flush(): Promise<void> {
    if (!this.hashesSupported()) return;
    const client = this.#deps.hashes() as HashRedis;
    const key = workerInstancesKey(this.#deps.effPrefix);
    const now = Date.now();
    const byField = new Map<string, OwnEntry[]>();
    for (const [id, entry] of this.#own) {
      if (entry.expiresAt <= now) {
        this.#own.delete(id);
        continue;
      }
      const field = `${entry.instance}#${this.#deps.nonce}`;
      const entries = byField.get(field) ?? [];
      entries.push(entry);
      byField.set(field, entries);
    }
    const writes: Promise<unknown>[] = [];
    for (const [field, entries] of byField) {
      writes.push(client.hset(key, field, encodeInstanceRecord(entries)));
      this.#writtenFields.add(field);
    }
    const stale = [...this.#writtenFields].filter((f) => !byField.has(f));
    if (stale.length > 0) {
      for (const f of stale) this.#writtenFields.delete(f);
      writes.push(client.hdel(key, ...stale));
    }
    await Promise.all(writes);
    if (this.#writtenFields.size === 0) return;
    if (
      this.#instancesUpkeepAt !== undefined &&
      now - this.#instancesUpkeepAt < INSTANCES_UPKEEP_MS
    )
      return;
    this.#instancesUpkeepAt = now;
    try {
      const [fields] = await Promise.all([
        client.hgetall(key),
        client.pexpire(key, INSTANCES_KEY_TTL_MS),
      ]);
      const expired = Object.entries(fields ?? {})
        .filter(([, raw]) => (decodeInstanceRecord(raw)?.expiresAt ?? 0) <= now)
        .map(([f]) => f);
      if (expired.length > 0) await client.hdel(key, ...expired);
    } catch (err) {
      this.#instancesUpkeepAt = undefined; // the next flush tries again
      throw err;
    }
  }

  /**
   * The keys older readers read: each token's per-instance key (`SET … EX`) and, for heartbeats and
   * descriptors, its field in the per-token hash. With hash commands they are written at most once
   * per `legacyWriteIntervalMs` per key (a changed descriptor, or `force`, at once) and live three
   * intervals; `legacyWrites: false` skips them. Without hash commands they are the whole registry,
   * written on every call with the caller's TTL.
   */
  async #writeLegacy(w: {
    instance: string;
    kind: WorkerRegistryKind;
    tokens: readonly string[];
    value: string;
    ttlSeconds: number;
    force?: boolean | undefined;
  }): Promise<void> {
    const hashes = this.hashesSupported();
    if (hashes && !this.#legacyWrites) return;
    const prefix = this.#deps.effPrefix;
    const now = Date.now();
    const ttlSeconds = hashes
      ? Math.max(w.ttlSeconds, Math.ceil((3 * this.#legacyWriteIntervalMs) / 1000))
      : w.ttlSeconds;
    const due: string[] = [];
    for (const token of w.tokens) {
      const key = perInstanceKey(prefix, w.kind, token, w.instance);
      const last = this.#legacyWrittenAt.get(key);
      const stale =
        !last ||
        now - last.at >= this.#legacyWriteIntervalMs ||
        (w.kind !== 'heartbeats' && last.value !== w.value);
      if (!hashes || w.force || stale) due.push(token);
    }
    if (due.length === 0) return;
    const keys = due.map((t) => perInstanceKey(prefix, w.kind, t, w.instance));
    for (const key of keys) this.#legacyWrittenAt.set(key, { at: now, value: w.value });
    const client = this.#deps.keys();
    try {
      await Promise.all(keys.map((key) => client.set(key, w.value, 'EX', ttlSeconds)));
      if (hashes && w.kind !== 'runConsumers') {
        const kind = w.kind;
        await Promise.all(
          due.map((t) => this.#writeTokenHash(kind, t, w.instance, w.value, ttlSeconds)),
        );
      }
    } catch (err) {
      for (const key of keys) this.#legacyWrittenAt.delete(key); // the next beat tries again
      throw err;
    }
  }

  /** Write `instance`'s `{ expiresAt, value }` into `token`'s per-token hash of `kind`; a new field,
   *  and otherwise every {@link LEGACY_HASH_UPKEEP_MS}, also refreshes the TTLs and index entry. */
  async #writeTokenHash(
    kind: 'heartbeats' | 'descriptors',
    token: string,
    instance: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    const client = this.#deps.hashes() as HashRedis;
    const prefix = this.#deps.effPrefix;
    const now = Date.now();
    const key = workerRegistryHashKey(prefix, kind, token);
    const added = await client.hset(
      key,
      instance,
      JSON.stringify({ expiresAt: now + ttlSeconds * 1000, value }),
    );
    const last = this.#legacyHashUpkeepAt.get(key);
    if (added > 0 || last === undefined || now - last.at >= LEGACY_HASH_UPKEEP_MS) {
      const prune = last === undefined || now - last.prunedAt >= LEGACY_HASH_PRUNE_MS;
      this.#legacyHashUpkeepAt.set(key, { at: now, prunedAt: prune ? now : last.prunedAt });
      try {
        const index = workerRegistryIndexKey(prefix);
        await Promise.all([
          client.pexpire(key, LEGACY_HASH_TTL_MS),
          client.zadd(index, now + LEGACY_HASH_TTL_MS, token),
          client.pexpire(index, LEGACY_HASH_TTL_MS),
        ]);
        if (!prune) return;
        const [fields] = await Promise.all([
          client.hgetall(key),
          client.zremrangebyscore(index, '-inf', now),
        ]);
        const expired = Object.entries(fields ?? {})
          .filter(([, stored]) => liveRegistryValue(stored, now) === undefined)
          .map(([field]) => field);
        if (expired.length > 0) await client.hdel(key, ...expired);
      } catch (err) {
        this.#legacyHashUpkeepAt.delete(key); // the next write tries again
        throw err;
      }
    }
  }

  // --- read side -----------------------------------------------------------------------------

  /** This process's own live entries, read from memory: an instance sees what it advertises at once. */
  #ownEntries(now: number): RegistrySnapshot {
    const out = emptySnapshot();
    for (const e of this.#own.values()) {
      if (e.expiresAt <= now) continue;
      out[e.kind].push({
        token: e.token,
        instance: e.instance,
        raw: e.value,
        expiresAt: e.expiresAt,
      });
    }
    return out;
  }

  /**
   * ONE `HGETALL` of the instances hash, reused while younger than `maxAgeMs` (concurrent callers
   * join the read in flight). This writer's own fields are skipped. A failed read is not kept: it is
   * reported, and a non-`fresh` reader gets the previous read (entries carry their own expiry, so a
   * Redis blip reads as slightly stale rather than failing); a `fresh` reader, or one with no
   * previous read, gets the error.
   */
  async #instancesSnapshot(maxAgeMs: number): Promise<RegistrySnapshot> {
    const last = this.#snapshot;
    if (last && Date.now() - last.at < maxAgeMs) return last.entries;
    if (!this.#snapshotRead) {
      const client = this.#deps.hashes() as HashRedis;
      const startedAt = Date.now();
      const read = client.hgetall(workerInstancesKey(this.#deps.effPrefix)).then((fields) => {
        const entries = decodeInstancesHash(fields ?? {}, `#${this.#deps.nonce}`);
        this.#snapshot = { at: startedAt, entries };
        return entries;
      });
      this.#snapshotRead = read;
      const clear = () => {
        if (this.#snapshotRead === read) this.#snapshotRead = undefined;
      };
      read.then(clear, clear);
    }
    try {
      return await this.#snapshotRead;
    } catch (err) {
      if (maxAgeMs === 0 || !last) throw err;
      this.#deps.onError(err);
      return last.entries;
    }
  }

  /**
   * Every live entry: this process's own, the other writers' fields (at most `maxAgeMs` old, `0` for
   * a fresh read) and the per-instance keys of writers that only write those. The first entry for a
   * (token, instance) wins, in that order. `runQueues` also walks those run queues' consumer keys.
   */
  async entries(maxAgeMs: number, runQueues: readonly string[] = []): Promise<RegistrySnapshot> {
    const hashes = this.hashesSupported();
    const walks = [this.#walk(`${this.#deps.effPrefix}-worker-`, maxAgeMs === 0)];
    for (const queue of runQueues) walks.push(this.#walk(`${queue}-consumer:`, maxAgeMs === 0));
    const [hashed, ...walked] = await Promise.all([
      hashes ? this.#instancesSnapshot(maxAgeMs) : Promise.resolve(emptySnapshot()),
      ...walks,
    ]);
    const legacy = emptySnapshot();
    for (const w of walked) for (const kind of KINDS) legacy[kind].push(...w[kind]);
    const now = Date.now();
    const own = this.#ownEntries(now);
    const live = (e: RegistryEntry) => e.expiresAt === undefined || e.expiresAt > now;
    // A throttled walk is up to an interval old: keep a walked beat that was live at the walk.
    const window = this.#deps.beatTtlMs + (hashes ? this.#legacyScanIntervalMs : 0);
    const keepWalked = (e: RegistryEntry) => {
      const at = this.#deps.beatAt(e.raw);
      return at === 0 || now - at < window;
    };
    const out = emptySnapshot();
    for (const kind of ['heartbeats', 'runConsumers'] as const) {
      out[kind] = mergeEntries(
        mergeEntries(own[kind], hashed[kind].filter(live)),
        legacy[kind],
        keepWalked,
      );
    }
    // A walked descriptor carries no beat time: keep it only while its writer has a live heartbeat
    // for the same token, so a dead writer's descriptor never outlives its liveness.
    const beating = new Set(out.heartbeats.map((e) => `${e.token}\n${e.instance}`));
    out.descriptors = mergeEntries(
      mergeEntries(own.descriptors, hashed.descriptors.filter(live)),
      legacy.descriptors,
      (e) => beating.has(`${e.token}\n${e.instance}`),
    );
    return out;
  }

  /**
   * The per-instance keys under `pattern` (`<pattern>*`): ONE SCAN walk shared by every reader in
   * this process, started at most once per `legacyScanIntervalMs`. After the first walk readers get
   * the last walk at once while a due walk runs in the background; a failed walk is reported and
   * keeps the previous keys. `legacyScan: false` skips it. A client without hash commands has nothing
   * else to read, so it walks on every read (reused {@link WORKER_HEARTBEAT_READ_TTL_MS}, `fresh`
   * walks again) and a failed walk fails the read.
   */
  #walk(pattern: string, fresh: boolean): Promise<RegistrySnapshot> {
    const hashes = this.hashesSupported();
    if (hashes && !this.#legacyScan) return Promise.resolve(emptySnapshot());
    const interval = hashes ? this.#legacyScanIntervalMs : WORKER_HEARTBEAT_READ_TTL_MS;
    let slot = this.#walks.get(pattern);
    if (!slot) {
      slot = { at: undefined, snapshot: undefined, inFlight: undefined };
      this.#walks.set(pattern, slot);
    }
    const s = slot;
    const last = s.snapshot;
    const reusable =
      last !== undefined &&
      s.at !== undefined &&
      !(fresh && !hashes) &&
      Date.now() - s.at < interval;
    if (last && reusable) return Promise.resolve(last);
    if (!s.inFlight) {
      const startedAt = Date.now();
      const read = this.#scan(pattern, hashes ? LEGACY_SCAN_COUNT : SCAN_COUNT).then(
        (snapshot) => {
          s.at = startedAt;
          s.snapshot = snapshot;
          return snapshot;
        },
        (err: unknown) => {
          if (!hashes) throw err;
          this.#deps.onError(err);
          s.at = startedAt;
          s.snapshot = last ?? emptySnapshot();
          return s.snapshot;
        },
      );
      s.inFlight = read;
      const clear = () => {
        if (s.inFlight === read) s.inFlight = undefined;
      };
      read.then(clear, clear);
    }
    if (last && hashes) return Promise.resolve(last);
    return s.inFlight;
  }

  /** Forget a withdrawn entry in the cached walks, so this process stops reporting it at once. */
  #forgetWalked(kind: WorkerRegistryKind, token: string, instance: string): void {
    for (const slot of this.#walks.values()) {
      if (!slot.snapshot) continue;
      slot.snapshot = {
        ...slot.snapshot,
        [kind]: slot.snapshot[kind].filter((e) => !(e.token === token && e.instance === instance)),
      };
    }
  }

  /** One SCAN walk of `<pattern>*`, MGET per page, sorted into entries by key shape. */
  async #scan(pattern: string, count: number): Promise<RegistrySnapshot> {
    const client = this.#deps.keys();
    const prefix = this.#deps.effPrefix;
    const heartbeatAt = `${prefix}-worker-heartbeat:`;
    const descriptorAt = `${prefix}-worker-descriptor:`;
    const out = emptySnapshot();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${pattern}*`, 'COUNT', count);
      cursor = next;
      if (keys.length === 0) continue;
      const get = client.get?.bind(client);
      const raws = client.mget
        ? await client.mget(...keys)
        : await Promise.all(keys.map((k) => (get ? get(k) : Promise.resolve(null))));
      keys.forEach((key, i) => {
        const raw = raws[i];
        if (raw == null) return; // expired between the SCAN and the MGET
        let kind: WorkerRegistryKind;
        let rest: string;
        let token: string | undefined;
        if (key.startsWith(heartbeatAt)) {
          kind = 'heartbeats';
          rest = key.slice(heartbeatAt.length);
        } else if (key.startsWith(descriptorAt)) {
          kind = 'descriptors';
          rest = key.slice(descriptorAt.length);
        } else if (pattern.endsWith('-consumer:') && key.startsWith(pattern)) {
          kind = 'runConsumers';
          token = pattern.slice(0, -'-consumer:'.length);
          rest = key.slice(pattern.length);
        } else {
          return;
        }
        if (token !== undefined) {
          out[kind].push({ token, instance: rest, raw });
          return;
        }
        const sep = rest.indexOf(':');
        out[kind].push({
          token: sep === -1 ? rest : rest.slice(0, sep),
          instance: sep === -1 ? '' : rest.slice(sep + 1),
          raw,
        });
      });
    } while (cursor !== '0');
    return out;
  }
}
