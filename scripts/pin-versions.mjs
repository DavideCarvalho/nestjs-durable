#!/usr/bin/env node
// Pins every `dependencies` / `devDependencies` specifier to the EXACT installed version.
// Leaves `peerDependencies` (which must stay as ranges) and `workspace:` protocol untouched.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function globDirs(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((p) => statSync(p).isDirectory());
}

const pkgDirs = [
  root,
  ...globDirs(join(root, 'packages')),
  ...globDirs(join(root, 'examples')),
  join(root, 'website'),
];

/** Resolve the installed version of `dep` as seen from `fromDir`. */
function installedVersion(fromDir, dep) {
  // pnpm symlinks each workspace package's deps into its own node_modules.
  const candidates = [join(fromDir, 'node_modules', dep, 'package.json')];
  // Fall back to the repo root store.
  candidates.push(join(root, 'node_modules', dep, 'package.json'));
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return JSON.parse(readFileSync(c, 'utf8')).version;
      } catch {}
    }
  }
  return null;
}

function pinBlock(block, dir, changes) {
  if (!block) return;
  for (const [dep, spec] of Object.entries(block)) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('workspace:')) continue; // keep workspace protocol
    if (spec.startsWith('catalog:') || spec.startsWith('link:') || spec.startsWith('file:'))
      continue;
    // Only pin range-y specifiers (caret/tilde/x/>=). Already-exact stays.
    if (/^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$/.test(spec)) continue;
    const version = installedVersion(dir, dep);
    if (version) {
      block[dep] = version;
      changes.push(`${dep}: ${spec} -> ${version}`);
    }
  }
}

let totalChanges = 0;
for (const dir of pkgDirs) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const changes = [];
  pinBlock(json.dependencies, dir, changes);
  pinBlock(json.devDependencies, dir, changes);
  // peerDependencies intentionally left as ranges.
  if (changes.length > 0) {
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    totalChanges += changes.length;
    console.log(`\n${json.name ?? dir}:`);
    for (const c of changes) console.log(`  ${c}`);
  }
}
console.log(`\nPinned ${totalChanges} specifier(s) to exact versions.`);
