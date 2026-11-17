import { randomUUID } from 'node:crypto';

/**
 * The write side of the worker registry for {@link runRedisWorker}: the SAME layout the BullMQ
 * transport (`@dudousxd/nestjs-durable-transport-bullmq`) and the AdonisJS durable lib read and write.
 *
 * - `<prefix>-workers:instances`: one hash per prefix, one field per writing process
 *   (`<instanceId>#<nonce>`), whose value lists every token the instance serves grouped by value:
 *   `{ v: 1, instance, expiresAt, heartbeats: [{ value, expiresAt, tokens }], descriptors: [...] }`.
 *   One `HSET` per beat whatever the number of tokens; readers do one `HGETALL`.
 * - While `legacyWrites` is on, the per-instance keys older readers read
 *   (`<prefix>-worker-heartbeat:<token>:<instance>`, `<prefix>-worker-descriptor:<token>:<instance>`),
 *   refreshed every `legacyWriteIntervalMs` and living three intervals.
 *
 * Kept as a copy of the transport's encoder rather than an import: the transport takes this package
 * as a peer with a wide range, so it cannot rely on a symbol only this version exports. A spec in the
 * transport pins both encoders to the same bytes.
 */

/** Version of the field layout; a reader skips a field of a version it does not know. */
const INSTANCE_RECORD_VERSION = 1;

/** One entry of a registry field. */
export interface RegistryFieldEntry {
  kind: 'heartbeats' | 'descriptors';
  token: string;
  value: string;
  expiresAt: number;
}

/** Encode one instance's entries as its `<prefix>-workers:instances` field value. */
export function encodeInstanceRecord(
  instance: string,
  entries: readonly RegistryFieldEntry[],
): string {
  const record = {
    v: INSTANCE_RECORD_VERSION,
    instance,
    expiresAt: 0,
    heartbeats: [] as { value: string; expiresAt: number; tokens: string[] }[],
    descriptors: [] as { value: string; expiresAt: number; tokens: string[] }[],
  };
  const groups = new Map<string, { value: string; expiresAt: number; tokens: string[] }>();
  for (const entry of entries) {
    record.expiresAt = Math.max(record.expiresAt, entry.expiresAt);
    const id = `${entry.kind}\n${entry.value}`;
    let group = groups.get(id);
    if (!group) {
      group = { value: entry.value, expiresAt: entry.expiresAt, tokens: [] };
      groups.set(id, group);
      record[entry.kind].push(group);
    }
    group.expiresAt = Math.max(group.expiresAt, entry.expiresAt);
    group.tokens.push(entry.token);
  }
  return JSON.stringify(record);
}

/** `<prefix>-workers:instances` — the registry hash. */
export function workerInstancesKey(prefix: string): string {
  return `${prefix}-workers:instances`;
}

/** The Redis commands the writer uses; without the hash ones only the per-instance keys are written. */
export interface RegistryWriterRedis {
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  del?(...keys: string[]): Promise<unknown>;
  hset?(key: string, field: string, value: string): Promise<unknown>;
  hgetall?(key: string): Promise<Record<string, string>>;
  hdel?(key: string, ...fields: string[]): Promise<unknown>;
  pexpire?(key: string, ms: number): Promise<unknown>;
}

/** Options of the runner's registry writes (see {@link RegistryWriter}). */
export interface WorkerRegistryWriteOptions {
  /** Also write the per-instance keys older readers read. Default `true`. */
  legacyWrites?: boolean | undefined;
  /** How often (ms) those keys are refreshed; they live three intervals. Default `30_000`. */
  legacyWriteIntervalMs?: number | undefined;
}

const DEFAULT_LEGACY_WRITE_INTERVAL_MS = 30_000;
/** How long the instances hash outlives the last upkeep of a writer. */
const INSTANCES_KEY_TTL_MS = 10 * 60_000;
/** How often a writer refreshes the hash's TTL and deletes expired fields of other writers. */
const INSTANCES_UPKEEP_MS = 5 * 60_000;

/** One process's beats into the registry: its field in the hash, plus the per-instance keys. */
export class RegistryWriter {
  readonly #client: RegistryWriterRedis;
  readonly #prefix: string;
  readonly #instance: string;
  readonly #field: string;
  readonly #legacyWrites: boolean;
  readonly #legacyWriteIntervalMs: number;
  #legacyWrittenAt: number | undefined;
  #upkeepAt: number | undefined;
  #wrote = false;
  readonly #legacyKeys = new Set<string>();

  constructor(
    client: RegistryWriterRedis,
    prefix: string,
    instance: string,
    options: WorkerRegistryWriteOptions = {},
  ) {
    this.#client = client;
    this.#prefix = prefix;
    this.#instance = instance;
    this.#field = `${instance}#${randomUUID().slice(0, 8)}`;
    this.#legacyWrites = options.legacyWrites !== false;
    const interval = options.legacyWriteIntervalMs;
    this.#legacyWriteIntervalMs =
      interval !== undefined && Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_LEGACY_WRITE_INTERVAL_MS;
  }

  #hashes(): boolean {
    const c = this.#client;
    return (
      typeof c.hset === 'function' &&
      typeof c.hgetall === 'function' &&
      typeof c.hdel === 'function' &&
      typeof c.pexpire === 'function'
    );
  }

  /**
   * One beat: `heartbeat` and `descriptor` for every token, live `ttlSeconds`. `keys` maps each
   * entry to its per-instance key for older readers.
   */
  async beat(b: {
    tokens: readonly string[];
    heartbeat: string;
    descriptor: string;
    ttlSeconds: number;
    heartbeatKey: (token: string) => string;
    descriptorKey: (token: string) => string;
  }): Promise<void> {
    const now = Date.now();
    const expiresAt = now + b.ttlSeconds * 1000;
    const writes: Promise<unknown>[] = [];
    const hashes = this.#hashes();
    if (hashes) {
      const entries: RegistryFieldEntry[] = [];
      for (const token of b.tokens) {
        entries.push({ kind: 'heartbeats', token, value: b.heartbeat, expiresAt });
        entries.push({ kind: 'descriptors', token, value: b.descriptor, expiresAt });
      }
      const key = workerInstancesKey(this.#prefix);
      writes.push(
        (this.#client.hset as NonNullable<RegistryWriterRedis['hset']>)(
          key,
          this.#field,
          encodeInstanceRecord(this.#instance, entries),
        ),
      );
      this.#wrote = true;
      if (this.#upkeepAt === undefined || now - this.#upkeepAt >= INSTANCES_UPKEEP_MS) {
        this.#upkeepAt = now;
        writes.push(this.#upkeep(key, now));
      }
    }
    const legacyDue =
      !hashes ||
      (this.#legacyWrites &&
        (this.#legacyWrittenAt === undefined ||
          now - this.#legacyWrittenAt >= this.#legacyWriteIntervalMs));
    if (legacyDue) {
      this.#legacyWrittenAt = now;
      const ttl = hashes
        ? Math.max(b.ttlSeconds, Math.ceil((3 * this.#legacyWriteIntervalMs) / 1000))
        : b.ttlSeconds;
      for (const token of b.tokens) {
        const hk = b.heartbeatKey(token);
        const dk = b.descriptorKey(token);
        this.#legacyKeys.add(hk);
        this.#legacyKeys.add(dk);
        writes.push(this.#client.set(hk, b.heartbeat, 'EX', ttl));
        writes.push(this.#client.set(dk, b.descriptor, 'EX', ttl));
      }
    }
    await Promise.all(writes);
  }

  /** Refresh the hash's TTL and delete other writers' expired fields (a crashed process). */
  async #upkeep(key: string, now: number): Promise<void> {
    const c = this.#client as Required<RegistryWriterRedis>;
    try {
      const [fields] = await Promise.all([c.hgetall(key), c.pexpire(key, INSTANCES_KEY_TTL_MS)]);
      const expired = Object.entries(fields ?? {})
        .filter(([, raw]) => {
          try {
            const parsed = JSON.parse(raw) as { expiresAt?: unknown };
            return typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now;
          } catch {
            return true;
          }
        })
        .map(([field]) => field);
      if (expired.length > 0) await c.hdel(key, ...expired);
    } catch (err) {
      this.#upkeepAt = undefined; // the next beat tries again
      throw err;
    }
  }

  /** Clean shutdown: remove this process's field and per-instance keys. */
  async remove(): Promise<void> {
    const removals: Promise<unknown>[] = [];
    if (this.#wrote && this.#hashes()) {
      removals.push(
        (this.#client.hdel as NonNullable<RegistryWriterRedis['hdel']>)(
          workerInstancesKey(this.#prefix),
          this.#field,
        ),
      );
    }
    if (this.#legacyKeys.size > 0 && this.#client.del) {
      removals.push(this.#client.del(...this.#legacyKeys));
    }
    await Promise.allSettled(removals);
  }
}
