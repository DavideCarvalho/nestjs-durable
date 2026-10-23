/**
 * A `redis://` / `rediss://` URL as ioredis connection options. BullMQ's `Queue`/`Worker` only
 * understand an options object or a `Redis` instance: a bare string is `Object.assign`ed onto their
 * defaults character by character and silently connects to `127.0.0.1:6379` instead of the URL's
 * host. `rediss:` turns on TLS; the path's first segment selects the db. Query parameters are refused
 * rather than dropped — pass connection options for anything beyond host, port, credentials, db, TLS.
 */
export function redisUrlToOptions(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid Redis URL: ${url}`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`expected a redis:// or rediss:// URL, got ${parsed.protocol}`);
  }
  if (parsed.search) {
    throw new Error(
      `query parameters in a Redis URL are not supported (${parsed.search}); pass connection options instead`,
    );
  }
  const options: ReturnType<typeof redisUrlToOptions> = {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace(/^\//, '').split('/')[0];
  if (db) {
    const n = Number(db);
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid Redis db "${db}" in ${url}`);
    options.db = n;
  }
  if (parsed.protocol === 'rediss:') options.tls = {};
  return options;
}

/** `connection` with a `redis://` string turned into options; anything else is returned as-is. */
export function normalizeRedisConnection<T>(
  connection: T,
): T | ReturnType<typeof redisUrlToOptions> {
  return typeof connection === 'string' ? redisUrlToOptions(connection) : connection;
}
