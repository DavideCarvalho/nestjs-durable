---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-cli': minor
---

A migration path from the official `@nestjs/workflows` to nestjs-durable.

- **Core, `parentClose`** on `ctx.child` / `ctx.startChild` (`'cancel'` | `'terminate'` | `'abandon'`): what happens to a live child when its in-process parent completes or fails; `'abandon'` children are also skipped by the cancel cascade. The child carries the tag `parent-close:<policy>`. Omitted, behaviour is unchanged.
- **Core, `rrule` schedules**: `engine.schedules.create({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', timezone })`, an RFC 5545 subset (optional `DTSTART` line) evaluated in the zone with no dependency; unsupported parts are refused by name. Stored in the schedule's JSON spec: no migration. `parseRRule` / `nextRRuleFireMs` / `prevRRuleFireMs` are exported.
- **`@dudousxd/nestjs-durable/migrate-from-nestjs-workflows`** (new subpath; `@nestjs/workflows` and `@dudousxd/nestjs-durable-workflows-gateway` are optional peers loaded only there): `MigrationClient` (new starts on durable; `signal` / `cancel` / `getStatus` / `result` act on the engine that owns the id; `remainingOnOfficial()` for the drain), `DurableMigrationModule.forRoot()`, and `DurableMigrationModule.console()` + `CombinedRunGateway` for one console over both engines.
- **CLI**: `durable migrate nestjs-workflows <glob…> [--dry-run]`, a ts-morph codemod for the 1:1 cases that leaves `// TODO(durable-migrate)` comments on the rest.
