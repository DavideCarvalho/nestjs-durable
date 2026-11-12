import { noNondeterminism } from './no-nondeterminism';

export const rules = {
  'no-nondeterminism': noNondeterminism,
};

// Read at load time, so `meta.version` (part of ESLint's cache key) always matches the release.
// `../package.json` resolves to the package root from both `src/` and the built `dist/`.
const { name, version } = require('../package.json') as { name: string; version: string };

const plugin = {
  meta: { name, version },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat-config preset: `extends` it (or spread) to turn the rule on. Defined after `plugin` so it can
// reference the plugin object itself (the flat-config way to register a plugin + its rules).
plugin.configs.recommended = {
  plugins: { '@dudousxd/nestjs-durable': plugin },
  rules: { '@dudousxd/nestjs-durable/no-nondeterminism': 'error' },
};

// Named exports of every plugin field: Node hands an ESM `import durable from …` of this CommonJS
// module its `module.exports` (these named exports), not `exports.default`, so `meta` has to be
// here too for ESLint to identify (and cache) the plugin.
export const meta = plugin.meta;
export const configs = plugin.configs;
export default plugin;
