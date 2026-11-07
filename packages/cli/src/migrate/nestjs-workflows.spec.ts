import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TODO, migrateFiles, migrateSource } from './nestjs-workflows';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

const header = `import { Workflow, WorkflowClient, type WorkflowContext } from '@nestjs/workflows';\n`;

describe('durable migrate nestjs-workflows', () => {
  it('rewrites the fixture to its expected durable form (before → after)', () => {
    const result = migrateSource(fixture('order.workflow.before.ts.txt'));
    expect(result.text).toBe(fixture('order.workflow.after.ts.txt'));
    expect(result.todos).toBe(6);
  });

  it('is idempotent: a migrated file has no official import left and is not touched again', () => {
    const once = migrateSource(fixture('order.workflow.before.ts.txt')).text;
    expect(migrateSource(once)).toEqual({ text: once, changed: false, todos: 0 });
  });

  it('leaves files without @nestjs/workflows alone', () => {
    const text = `const ctx = { step: (a: string) => a };\nctx.step('x');\n`;
    expect(migrateSource(text)).toEqual({ text, changed: false, todos: 0 });
  });

  it('only rewrites receivers typed WorkflowContext / WorkflowClient', () => {
    const out = migrateSource(
      `${header}const ctx = { now: () => 1 };\nexport const n = ctx.now();\n@Workflow('w')\nexport class W {\n  async run(ctx: WorkflowContext) {\n    return ctx.now();\n  }\n}\n`,
    ).text;
    expect(out).toContain('export const n = ctx.now();');
    expect(out).toContain('return (await ctx.now());');
  });

  it('maps waitForAny 1:1: signalWait → token, timer kept, child handles → ctx.childWait(id)', () => {
    const out = migrateSource(
      `${header}@Workflow('w')\nexport class W {\n  async run(ctx: WorkflowContext, input: { id: string }) {\n    const kid = await ctx.startChild('kid', {});\n    const t = ctx.timer({ until: 5 });\n    const r = await ctx.waitForAny('x', { a: ctx.signalWait<number>('a', { key: input.id }), b: ctx.signalWait('b'), kid, t, late: ctx.timer('1h'), now: await ctx.startChild('other', {}) });\n    return r;\n  }\n}\n`,
    );
    expect(out.todos).toBe(0);
    expect(out.text).toContain(
      "await ctx.waitForAny('x', { a: ctx.signalWait<number>(`a:${input.id}`), b: ctx.signalWait('b'), kid: ctx.childWait(kid), t, late: ctx.timer('1h'), now: ctx.childWait(await ctx.startChild('other', {})) });",
    );
    // The handle is only raced, so the handle → id change needs no TODO.
    expect(out.text).not.toContain(TODO);
  });

  it('flags a waitForAny condition it cannot classify, and signalWait match', () => {
    const out = migrateSource(
      `${header}@Workflow('w')\nexport class W {\n  async run(ctx: WorkflowContext, c: unknown) {\n    return ctx.waitForAny('x', { c, m: ctx.signalWait('m', { match: (p) => !!p }) });\n  }\n}\n`,
    ).text;
    expect(out).toContain(
      `// ${TODO}: could not tell whether \`c\` is a condition or a child handle`,
    );
    expect(out).toContain(`// ${TODO}: signalWait \`match\` has no durable equivalent`);
    expect(out).toContain("return ctx.waitForAny('x', { c, m: ctx.signalWait('m') });");
  });

  it('maps WorkflowCondition / WorkflowAnyResult types to their durable names', () => {
    const out = migrateSource(
      `import { type WorkflowCondition, type WorkflowAnyResult } from '@nestjs/workflows';\nexport type A = WorkflowCondition<string>;\nexport type B = WorkflowAnyResult<{ a: A }>;\n`,
    ).text;
    expect(out).toContain(
      "import { type WaitAnyResult, type WaitCondition } from '@dudousxd/nestjs-durable-core';",
    );
    expect(out).toContain('export type A = WaitCondition<string>;');
    expect(out).toContain('export type B = WaitAnyResult<{ a: A }>;');
  });

  it('startChild keeps parentClose, maps id, and flags the handle → id change', () => {
    const out = migrateSource(
      `${header}@Workflow('w')\nexport class W {\n  async run(ctx: WorkflowContext) {\n    await ctx.startChild('kid', { a: 1 }, { id: 'k1', parentClose: 'terminate', timeout: '1h' });\n  }\n}\n`,
    ).text;
    expect(out).toContain(
      "await ctx.startChild('kid', { a: 1 }, { childId: 'k1', parentClose: 'terminate' });",
    );
    expect(out).toContain(`// ${TODO}: startChild({ timeout }) has no durable child option`);
    expect(out).toContain(`// ${TODO}: durable's ctx.startChild resolves the child's run id`);
  });

  it('client.signal keeps its dedupe id; client.start in a transaction leaves a TODO', () => {
    const out = migrateSource(
      `${header}export class C {\n  constructor(private readonly c: WorkflowClient) {}\n  async a(tx: unknown) {\n    await this.c.signal('paid', { ok: true }, { key: 'o1', id: 'evt-1' });\n    await this.c.start('w', {}, { id: 'r1', transaction: tx });\n  }\n}\n`,
    ).text;
    expect(out).toContain("await this.c.signal('paid:o1', { ok: true }, { id: 'evt-1' });");
    expect(out).not.toContain('signal dedupe');
    expect(out).toContain("await this.c.start('w', {}, 'r1');");
    expect(out).toContain('DurableOutbox.start(tx, …) from @dudousxd/nestjs-durable/outbox');
    expect(out).toContain('constructor(private readonly c: WorkflowService) {}');
  });

  it('migrates files on disk by glob, and --dry-run writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-migrate-'));
    const file = join(dir, 'order.workflow.ts');
    writeFileSync(file, fixture('order.workflow.before.ts.txt'));
    const dry = migrateFiles([join(dir, '**/*.ts')], { dryRun: true });
    expect(dry.files).toEqual([{ path: file, changed: true, todos: 6 }]);
    expect(readFileSync(file, 'utf8')).toBe(fixture('order.workflow.before.ts.txt'));
    migrateFiles([join(dir, '**/*.ts')]);
    expect(readFileSync(file, 'utf8')).toBe(fixture('order.workflow.after.ts.txt'));
  });
});
