// Runs a TypeScript entry in a fresh Node process the way Vitest runs a spec: through vite-node with
// a Vitest config, so the workspace aliases (packages resolve to their `src/`) and the SWC decorator
// metadata Nest needs apply. Used by the two-process spec to boot real, separate app processes.
//
//   node run-node.mjs <vite config> <entry.ts>
import { createServer } from 'vite';
import { ViteNodeRunner } from 'vite-node/client';
import { ViteNodeServer } from 'vite-node/server';
import { installSourcemapsSupport } from 'vite-node/source-map';

const [configFile, entry] = process.argv.slice(2);
if (!configFile || !entry) {
  console.error('usage: node run-node.mjs <vite config> <entry.ts>');
  process.exit(2);
}

const server = await createServer({
  configFile,
  logLevel: 'error',
  server: { hmr: false, watch: null },
});
await server.pluginContainer.buildStart({});

const node = new ViteNodeServer(server, {
  // The same inlining the Vitest configs do: diagnostics' lazy `import()` of
  // `@dudousxd/nestjs-durable-diagnostics/delivery` must resolve through the aliases.
  deps: { inline: ['@dudousxd/nestjs-diagnostics'] },
});
installSourcemapsSupport({ getSourceMap: (source) => node.getSourceMap(source) });

const runner = new ViteNodeRunner({
  root: server.config.root,
  base: server.config.base,
  fetchModule: (id) => node.fetchModule(id),
  // The runner reports a file outside vite's served paths as `/@fs//abs/path`, which vite resolves
  // nothing from: hand it the plain file path.
  resolveId: (id, importer) => node.resolveId(id, importer?.replace(/^\/@fs\/+/, '/')),
});
await runner.executeFile(entry);
