import type { AdmissionBackend } from '@dudousxd/nestjs-durable-core';
import type { Admission, AdmissionItem, QueueConfig } from '@dudousxd/nestjs-durable-core';
import { Redis, type RedisOptions } from 'ioredis';

export interface RedisAdmissionOptions {
  /** ioredis connection options, or a live ioredis instance to reuse. */
  connection: Redis | RedisOptions;
  /** Key prefix namespacing the admission keys. Defaults to `durable`. */
  prefix?: string;
  /**
   * Slot lease in ms — a crash-safety net, NOT the primary release path. An admitted slot auto-frees
   * after this long if `release` never runs (e.g. the holder pod crashed). Set comfortably ABOVE your
   * longest step duration so a still-running step's slot is never purged out from under it. Default 5m.
   */
  leaseMs?: number;
  /** Delay (ms) a blocked call is told to wait before re-trying admission. Default 1000. */
  retryMs?: number;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
}

// Atomic admit: purge expired leases, check rate window, check concurrency, enforce priority ordering
// among registered waiters, then take a leased slot — all in one round-trip so concurrent pods can't
// race past the cap. Returns {admitted (1|0), retryAt}. KEYS: slots(ZSET), waiters(ZSET), rate(string).
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local leaseExpiry = tonumber(ARGV[2])
local concurrency = tonumber(ARGV[3])
local rateLimit = tonumber(ARGV[4])
local ratePeriodMs = tonumber(ARGV[5])
local waiterId = ARGV[6]
local priorityScore = tonumber(ARGV[7])
local retryAt = tonumber(ARGV[8])
local hasOrdering = tonumber(ARGV[9])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

if rateLimit > 0 then
  local used = tonumber(redis.call('GET', KEYS[3]) or '0')
  if used >= rateLimit then return {0, retryAt} end
end

if concurrency > 0 then
  local inflight = redis.call('ZCARD', KEYS[1])
  if inflight >= concurrency then
    redis.call('ZADD', KEYS[2], priorityScore, waiterId)
    return {0, retryAt}
  end
end

if hasOrdering == 1 then
  redis.call('ZADD', KEYS[2], priorityScore, waiterId)
  local best = redis.call('ZRANGE', KEYS[2], 0, 0)
  if best[1] ~= waiterId then return {0, retryAt} end
end

if concurrency > 0 then
  redis.call('ZADD', KEYS[1], leaseExpiry, waiterId)
end
redis.call('ZREM', KEYS[2], waiterId)
if rateLimit > 0 then
  redis.call('INCR', KEYS[3])
  redis.call('PEXPIRE', KEYS[3], ratePeriodMs)
end
return {1, 0}
`;

// ioredis custom commands are defined dynamically, so the method isn't on the static type. This is
// the one localized cast the official typing story requires for `defineCommand`.
type AcquireFn = (
  slotsKey: string,
  waitersKey: string,
  rateKey: string,
  ...args: Array<string | number>
) => Promise<[number, number]>;
type RedisWithAcquire = Redis & { admissionAcquire: AcquireFn };

/**
 * A {@link AdmissionBackend} whose counts live in Redis, so `concurrency` / `rateLimit` / priority
 * ordering are enforced ACROSS every engine replica instead of per-process. Concurrency is tracked as
 * a leased sorted set (a crashed holder's slot auto-expires), the rate limit as a fixed-window
 * counter, and blocked callers register in a priority-ordered waiter set so the highest-priority one
 * wins the next freed slot. One atomic Lua acquire keeps concurrent pods from racing past the cap.
 *
 * FIFO-within-equal-priority is best-effort (Redis breaks score ties by member id, not arrival time).
 */
export class RedisAdmissionBackend implements AdmissionBackend {
  private readonly redis: RedisWithAcquire;
  private readonly prefix: string;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly clock: () => number;
  private readonly configs = new Map<string, QueueConfig>();

  constructor(options: RedisAdmissionOptions) {
    const base =
      options.connection instanceof Redis ? options.connection : new Redis(options.connection);
    this.prefix = options.prefix ?? 'durable';
    this.leaseMs = options.leaseMs ?? 300_000;
    this.retryMs = options.retryMs ?? 1000;
    this.clock = options.clock ?? Date.now;
    base.defineCommand('admissionAcquire', { numberOfKeys: 3, lua: ACQUIRE_LUA });
    this.redis = base as RedisWithAcquire;
  }

  register(config: QueueConfig): void {
    this.configs.set(config.name, config);
  }

  async tryAdmit(queue: string, item: AdmissionItem): Promise<Admission> {
    const config = this.configs.get(queue);
    if (!config) return { ok: true }; // unregistered queue → ungated
    const now = this.clock();
    const concurrency = config.concurrency ?? 0;
    const rate = config.rateLimit;
    const ratePeriodMs = rate?.periodMs ?? 0;
    const rateKey = rate
      ? this.rateKey(queue, Math.floor(now / rate.periodMs))
      : this.rateKey(queue, 0);
    // Order whenever a priority is given or key-fairness is configured — otherwise plain FIFO admit.
    const hasOrdering = item.priority != null || config.fairness === 'key' ? 1 : 0;
    const [admitted, retryAt] = await this.redis.admissionAcquire(
      this.slotsKey(queue),
      this.waitersKey(queue),
      rateKey,
      now,
      now + this.leaseMs,
      concurrency,
      rate?.limit ?? 0,
      ratePeriodMs,
      item.waiterId ?? `anon:${now}`,
      this.priorityScore(item.priority),
      now + this.retryMs,
      hasOrdering,
    );
    return admitted === 1 ? { ok: true } : { ok: false, retryAt };
  }

  async release(queue: string, slotId: string): Promise<void> {
    await this.redis.zrem(this.slotsKey(queue), slotId);
  }

  // Lib priority is "higher = more urgent"; a Redis ZSET admits the LOWEST score first, so negate.
  private priorityScore(priority?: number): number {
    return -(priority ?? 0);
  }

  private slotsKey(queue: string): string {
    return `${this.prefix}:adm:${queue}:slots`;
  }
  private waitersKey(queue: string): string {
    return `${this.prefix}:adm:${queue}:waiters`;
  }
  private rateKey(queue: string, window: number): string {
    return `${this.prefix}:adm:${queue}:rate:${window}`;
  }
}
