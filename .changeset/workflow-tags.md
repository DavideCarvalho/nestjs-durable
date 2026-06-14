---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
---

feat: workflow tags + search

Label runs and search/filter by them in the dashboard. Tags come from two sources, merged onto each
run:

- **Static** — `@Workflow({ name: 'pipeline', tags: ['etl', 'critical'] })` stamps every run of the
  workflow.
- **Per-run** — `WorkflowService.start(wf, input, runId, { tags: ['nightly'] })` (and
  `engine.start(..., { tags })`) adds run-scoped tags.

`WorkflowRun.tags` is stored across all store adapters (in-memory, TypeORM, MikroORM, Prisma,
Drizzle), and `RunQuery.tag` filters by an exact tag. The dashboard shows tags on each run (list +
detail) and adds a tag filter box; clicking a tag filters the list. The dashboard API gains a
`?tag=` query param.
