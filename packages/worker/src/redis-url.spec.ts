import { describe, expect, it } from 'vitest';
import { normalizeRedisConnection, redisUrlToOptions } from './redis-url';

describe('redisUrlToOptions', () => {
  it('maps host, port, credentials, db and TLS', () => {
    expect(redisUrlToOptions('redis://h:6380')).toEqual({ host: 'h', port: 6380 });
    expect(redisUrlToOptions('rediss://u:p%40ss@h/2')).toEqual({
      host: 'h',
      port: 6379,
      username: 'u',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
    expect(redisUrlToOptions('redis://:secret@h:1')).toEqual({
      host: 'h',
      port: 1,
      password: 'secret',
    });
  });

  it('refuses what it would otherwise drop or misread', () => {
    expect(() => redisUrlToOptions('http://h')).toThrow(/redis:\/\//);
    expect(() => redisUrlToOptions('redis://h?family=6')).toThrow(/query parameters/);
    expect(() => redisUrlToOptions('redis://h/x')).toThrow(/invalid Redis db/);
    expect(() => redisUrlToOptions('not a url')).toThrow(/invalid Redis URL/);
  });

  it('normalizeRedisConnection only rewrites strings', () => {
    const opts = { host: 'h', port: 1 };
    expect(normalizeRedisConnection(opts)).toBe(opts);
    expect(normalizeRedisConnection('redis://h:2')).toEqual({ host: 'h', port: 2 });
  });
});
