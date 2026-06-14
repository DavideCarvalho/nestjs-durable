import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/DavideCarvalho/nestjs-durable#${name}`,
);

type MessageId = 'useNow' | 'useRandom' | 'useUuid' | 'useNowDate';

/** True when `node` sits lexically inside the `run` method of a class decorated with `@Workflow`. */
/** A function/arrow passed as an argument to `ctx.step(...)` / `ctx.task(...)` — its body is run once
 *  and checkpointed, so non-determinism inside it is fine (only the orchestration body must be pure). */
function isCheckpointedCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn as never)) return false;
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'step' || callee.property.name === 'task')
  );
}

function isInWorkflowRun(node: TSESTree.Node): boolean {
  let cur: TSESTree.Node | undefined = node;
  let runMethod: TSESTree.MethodDefinition | undefined;
  while (cur) {
    // Crossing a `ctx.step`/`ctx.task` callback boundary before reaching `run` means the call is
    // inside a checkpointed step — not the deterministic orchestration body — so don't flag it.
    if (
      (cur.type === 'ArrowFunctionExpression' || cur.type === 'FunctionExpression') &&
      isCheckpointedCallback(cur)
    ) {
      return false;
    }
    if (
      cur.type === 'MethodDefinition' &&
      cur.key.type === 'Identifier' &&
      cur.key.name === 'run'
    ) {
      runMethod = cur;
      break;
    }
    cur = cur.parent;
  }
  if (!runMethod) return false;
  const classNode = runMethod.parent?.parent; // MethodDefinition → ClassBody → Class
  if (
    !classNode ||
    (classNode.type !== 'ClassDeclaration' && classNode.type !== 'ClassExpression')
  ) {
    return false;
  }
  return (classNode.decorators ?? []).some((d) => {
    const e = d.expression;
    if (e.type === 'Identifier') return e.name === 'Workflow';
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier') {
      return e.callee.name === 'Workflow';
    }
    return false;
  });
}

/** The receiver name of a member call: `crypto` for `crypto.x()` and `globalThis.crypto.x()`. */
function receiverName(object: TSESTree.Expression | TSESTree.Super): string | undefined {
  if (object.type === 'Identifier') return object.name;
  if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
    return object.property.name;
  }
  return undefined;
}

export const noNondeterminism = createRule<[], MessageId>({
  name: 'no-nondeterminism',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow non-deterministic sources (Date.now, Math.random, new Date, crypto.randomUUID) inside a @Workflow run — they differ across replays and silently corrupt a durable run. Use ctx.now()/ctx.random()/ctx.uuid().',
    },
    messages: {
      useNow:
        'Non-deterministic `{{call}}` inside a @Workflow run — use `ctx.now()` (recorded once, then replayed).',
      useRandom: 'Non-deterministic `Math.random()` inside a @Workflow run — use `ctx.random()`.',
      useUuid: 'Non-deterministic `crypto.randomUUID()` inside a @Workflow run — use `ctx.uuid()`.',
      useNowDate:
        'Non-deterministic `new Date()` inside a @Workflow run — use `new Date(await ctx.now())`.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        const prop = callee.property.name;
        const obj = receiverName(callee.object);
        const isBanned =
          ((obj === 'Date' || obj === 'performance') && prop === 'now') ||
          (obj === 'Math' && prop === 'random') ||
          (obj === 'crypto' && prop === 'randomUUID');
        if (!isBanned || !isInWorkflowRun(node)) return;
        if (prop === 'random') context.report({ node, messageId: 'useRandom' });
        else if (prop === 'randomUUID') context.report({ node, messageId: 'useUuid' });
        else context.report({ node, messageId: 'useNow', data: { call: `${obj}.now()` } });
      },
      NewExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length === 0 &&
          isInWorkflowRun(node)
        ) {
          context.report({ node, messageId: 'useNowDate' });
        }
      },
    };
  },
});
