import parser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { noNondeterminism } from './no-nondeterminism';

function lint(code: string) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, {
    languageOptions: {
      parser: parser as never,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { d: { rules: { rule: noNondeterminism as never } } },
    rules: { 'd/rule': 'error' },
  });
}

const workflow = (body: string) => `
  @Workflow({ name: 'wf', version: '1' })
  class W {
    async run(ctx) {
      ${body}
    }
  }
`;

describe('no-nondeterminism', () => {
  it('flags Date.now() inside a @Workflow run', () => {
    const msgs = lint(workflow('const t = Date.now();'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.message).toContain('ctx.now()');
  });

  it('flags Math.random(), new Date(), and crypto.randomUUID()', () => {
    expect(lint(workflow('const r = Math.random();'))[0]?.message).toContain('ctx.random()');
    expect(lint(workflow('const d = new Date();'))[0]?.message).toContain(
      'new Date(await ctx.now())',
    );
    expect(lint(workflow('const id = crypto.randomUUID();'))[0]?.message).toContain('ctx.uuid()');
    expect(lint(workflow('const id = globalThis.crypto.randomUUID();'))).toHaveLength(1);
  });

  it('allows the ctx escape hatches', () => {
    expect(lint(workflow('const t = await ctx.now(); const d = new Date(t);'))).toHaveLength(0);
  });

  it('does not flag the same calls outside a @Workflow run', () => {
    expect(lint('function f() { return Date.now(); }')).toHaveLength(0);
    // A non-`run` method of a @Workflow class is not the deterministic body.
    expect(
      lint(`
        @Workflow({ name: 'wf', version: '1' })
        class W { helper() { return Math.random(); } }
      `),
    ).toHaveLength(0);
    // A class method named run WITHOUT the @Workflow decorator is just a method.
    expect(lint('class Plain { run() { return Date.now(); } }')).toHaveLength(0);
  });
});
