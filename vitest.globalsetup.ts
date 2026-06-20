import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Vitest `globalSetup`: generate the store-prisma SQLite test client from the CURRENT schema, once,
 * in the main process before any worker spawns.
 *
 * The client lives in a gitignored `generated/client` dir, so on a fresh clone it is absent and after
 * a `prisma/*.prisma` schema change it goes stale — Prisma then rejects newly-added fields with
 * `Unknown argument` at query time (e.g. a freshly-added `priority` column). CI already runs
 * `prisma:generate` before tests; doing the same here keeps local `pnpm test` in sync with CI.
 *
 * It MUST live in globalSetup (one-shot, pre-workers) rather than each spec's setup: `column-naming.spec.ts`
 * imports the generated client at module load, so a per-file regenerate would race that read across
 * worker processes. The Postgres client (`generated/pg-client`) is intentionally NOT generated here —
 * the `*.db.spec.ts` suites are excluded from the default run and generate it themselves at test time.
 */
export default function setup(): void {
  const cwd = fileURLToPath(new URL('./packages/store-prisma', import.meta.url));
  execSync('npx prisma generate --schema prisma/test.prisma', { cwd, stdio: 'ignore' });
}
