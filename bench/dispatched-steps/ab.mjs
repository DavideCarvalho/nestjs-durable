// A/B driver: runs run.mjs for each build, alternating build by build and repeat by repeat, so both
// see the same machine load. Each run is its own process (fresh JIT, fresh database).
//
//   node bench/dispatched-steps/ab.mjs <scenario[,scenario]> A=<root> B=<root>[:ENV=VAL,...] [...]
//   e.g. node bench/dispatched-steps/ab.mjs seq200,throughput base=/tmp/durperf-base new=.
// Env: AB_REPEAT (default 3). Prints the median of each metric per build and scenario.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const [scenarios, ...specs] = process.argv.slice(2);
const builds = specs.map((spec) => {
  const at = spec.indexOf('=');
  const [name, rest] = [spec.slice(0, at), spec.slice(at + 1)];
  const [rel, envs] = rest.split(':');
  const root = resolve(rel);
  const env = Object.fromEntries((envs ? envs.split(',') : []).map((kv) => kv.split('=')));
  return { name, root, env };
});
const repeat = Number(process.env.AB_REPEAT ?? 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = {};
for (const scenario of scenarios.split(',')) {
  for (let r = 0; r < repeat; r += 1) {
    for (const b of builds) {
      const out = execFileSync('node', [runner, scenario], {
        env: { ...process.env, ...b.env, BENCH_ROOT: b.root, BENCH_REPEAT: '1' },
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
      const line = out.split('\n').find((l) => l.startsWith(`${scenario} `));
      const m = JSON.parse(line.slice(scenario.length + 1));
      results[scenario] ??= {};
      results[scenario][b.name] ??= [];
      results[scenario][b.name].push(m);
    }
  }
  for (const b of builds) {
    const runs = results[scenario][b.name];
    const med = Object.fromEntries(
      Object.keys(runs[0]).map((k) => [k, Number(median(runs.map((x) => x[k])).toFixed(2))]),
    );
    console.log(scenario, b.name, JSON.stringify(med));
  }
}
