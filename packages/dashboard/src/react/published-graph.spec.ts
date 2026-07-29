// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * Every package a PUBLISHED entry can reach must be declared here, as a dependency or a peer.
 *
 * The question that decides where a package belongs is not "does this console ship a bundled SPA"
 * — it is "is the package reachable from a published entry". This package publishes three: the
 * NestJS server module, the headless `./client`, and the `./react` launcher tier. `src/app/**` is
 * the SPA; vite bundles it into `dist/spa` and no published entry points at it, which is why the
 * shadcn layer (Base UI, cva, clsx, tailwind-merge) sits in `devDependencies`. This test is what
 * makes that claim checkable instead of asserted.
 *
 * It bundles `dist/**` with esbuild and records every bare specifier the bundler actually resolves.
 * That is the thing that has broken a host build before: a bundler *resolves* a re-exported module
 * even when nothing imports it, so neither a grep nor reading the entry file is proof — only
 * following the real graph is.
 *
 * Skipped when `dist/` is absent (a bare `vitest` run before `build`); CI builds first.
 */

const distDir = fileURLToPath(new URL('../../dist', import.meta.url));
const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const built = existsSync(`${distDir}/react/index.js`);

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function declaredPackages(): Set<string> {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest;
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/** `@scope/pkg/sub` and `pkg/sub` both belong to their package root. */
function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

/** Every bare specifier reachable from `entry`, per esbuild's own resolution. */
async function reachablePackages(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await build({
    entryPoints: [`${distDir}/${entry}`],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'record-bare-specifiers',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return null;
            if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
            // Mark external so resolution never fails: we want the import surface, not a build.
            if (!args.path.startsWith('node:')) seen.add(packageRoot(args.path));
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return seen;
}

describe.skipIf(!built)('published module graph', () => {
  it.each([['react/index.js'], ['client/durable-client.js'], ['server/index.js']])(
    'every package %s reaches is declared',
    async (entry) => {
      const declared = declaredPackages();
      const undeclared = [...(await reachablePackages(entry))].filter(
        (name) => !declared.has(name),
      );
      expect(undeclared.sort()).toEqual([]);
    },
  );

  it('the ./react launcher tier still reaches nothing but react', async () => {
    // Its whole promise: a host that wants only the "open the console" button installs only react.
    // Vendoring a component layer under `src/app/ui` is a fresh chance to break that.
    expect([...(await reachablePackages('react/index.js'))].sort()).toEqual(['react']);
  });

  it('no published entry reaches the SPA-only component layer', async () => {
    const spaOnly = [
      '@base-ui-components/react',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
    ];
    for (const entry of ['react/index.js', 'client/durable-client.js', 'server/index.js']) {
      const reachable = await reachablePackages(entry);
      expect(spaOnly.filter((name) => reachable.has(name))).toEqual([]);
    }
  });
});
