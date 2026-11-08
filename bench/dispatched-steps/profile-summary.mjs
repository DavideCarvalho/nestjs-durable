// Summarize a V8 .cpuprofile: self time by package and the hottest functions.
//   node bench/dispatched-steps/profile-summary.mjs <file.cpuprofile> [top=25]
import { readFileSync } from 'node:fs';

const prof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3] ?? 25);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = prof.timeDeltas;
prof.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dts[i] ?? 0)));
const pkgOf = (url) => {
  if (!url) return '(native/gc/idle)';
  const m = url.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1];
  if (url.includes('/packages/')) return `@dudousxd/${url.split('/packages/')[1].split('/')[0]}`;
  if (url.startsWith('node:')) return url.split('/')[0];
  return '(bench)';
};
const byPkg = new Map();
const byFn = new Map();
let total = 0;
for (const [id, us] of self) {
  const n = byId.get(id);
  const fn = n.callFrame.functionName || '(anonymous)';
  const pkg = fn === '(idle)' ? '(idle)' : pkgOf(n.callFrame.url);
  if (pkg === '(idle)') continue;
  total += us;
  byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + us);
  const key = `${fn} — ${pkg}`;
  byFn.set(key, (byFn.get(key) ?? 0) + us);
}
console.log(`busy ${(total / 1000).toFixed(0)} ms`);
for (const [k, v] of [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(
    `${(v / 1000).toFixed(0).padStart(7)} ms ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`,
  );
}
console.log('---');
for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${(v / 1000).toFixed(0).padStart(7)} ms  ${k}`);
}
