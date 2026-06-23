---
"@dudousxd/durable-worker": patch
---

Ship `@dudousxd/durable-worker` as a dual ESM + CJS build (was ESM-only).

A NestJS app compiled to CommonJS (SWC's default) reaches this package through
`@dudousxd/nestjs-durable`'s `DurableWorkerModule`, which `require()`s it. With an
ESM-only `exports` (no `require`/`default` condition), that `require` threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` at boot → CrashLoopBackOff for any CJS consumer.
The package now publishes `dist/index.cjs` + `dist/index.js` with matching
`import`/`require` export conditions (mirroring `@dudousxd/nestjs-durable`), so both
CJS and ESM consumers load it. No API change.
