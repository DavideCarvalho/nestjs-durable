import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import plugin, { meta } from './index';

describe('plugin meta', () => {
  it('carries the package name and version', () => {
    expect(plugin.meta).toEqual({ name: pkg.name, version: pkg.version });
    expect(meta).toBe(plugin.meta);
  });
});
