# Durability fixes implementation plan

Goal: fix singleton admission under same-millisecond starts and four unhandled Promise rejection paths.

1. Add failing regression tests for track, waitForRun, Nest tenant republishing, and Redis startup liveness. Replace finally tracking with then(done, done); reject and clean up waitForRun on read failures; catch asynchronous republisher and startup heartbeat failures. Add package patch changesets.
2. Introduce an atomic singleton admission store operation, persisting a reserved admission tag in existing run rows. Serialize read/claim with row locks (Postgres/MySQL) or database write transactions (SQLite). Count durable holders before ordering non-admitted waiters. Keep suspended/blocked/cancelling holders until terminal settlement; clear markers on manual retry. Test equal timestamps, reversed ids, parallel engines, limits, recovery, and release.
3. Implement the operation in every bundled store and the codec wrapper. Add shared store contract cases and real PostgreSQL/MySQL coverage. Verify failed operations do not permanently claim admission.
4. Run focused regressions, core suite, adapter SQLite suites and Docker/Testcontainers PostgreSQL/MySQL/Redis suites. Typecheck touched packages, format/lint changed files, review concurrency and retry behavior, then summarize evidence.

No publishing or deployment is requested; deliver reviewable changes on fix/singleton-and-unhandled-rejections.

Completed validation

- Core + Nest + Redis startup unit suites: 186 files, 857 tests passed.
- Local store/SQLite singleton matrix: 9 files, 422 tests passed.
- Selected real PostgreSQL/MySQL singleton claims, parked denial, cancellation, cross-driver and scoped-store cases: 4 files, 37 tests passed.
- Real PostgreSQL lock-timeout and Redis startup/conformance suites: 3 files, 15 tests passed.
- Separate Node processes without an unhandledRejection listener: all four storage-failure scenarios exited 0; PostgreSQL singleton maximum simultaneous bodies was 1.
- Typechecks passed for core, Nest, Redis admission, Drizzle, TypeORM, MikroORM and Prisma. Core ESM/CJS/types build passed. Biome checked all 30 changed TypeScript files; git diff --check passed.
- Broader SQL matrix exposed four pre-existing MySQL millisecond truncation failures (TypeORM/MikroORM updateRun wakeAt and buffered events publishedAt). The same four failures were reproduced against unchanged main 7c05f60; they are outside this fix.
- Independent review identified marker inheritance and cancellation races; both now have failing-before/passing-after regressions and are corrected. Final review found no important unresolved issues.

Release: Promise fixes have patch changesets. Singleton adds an atomic store contract, so core has a minor changeset and bundled adapters have patch changesets. No schema migration; custom stores must implement tryAdmitSingleton. Drain existing singleton runs and upgrade workers/stores together before resuming starts.
