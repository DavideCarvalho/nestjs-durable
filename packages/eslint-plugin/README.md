# @dudousxd/nestjs-durable-eslint-plugin

Lint for non-deterministic sources inside a durable `@Workflow` — `Date.now()`, `Math.random()`,
`new Date()`, `crypto.randomUUID()`, `performance.now()`. These differ on every replay and silently
corrupt a durable run; use the checkpointed `ctx.now()` / `ctx.random()` / `ctx.uuid()` instead.

Ships the rule for **both** ecosystems.

## ESLint (flat config) — recommended

AST-aware: only flags the banned calls inside the `run` method of a `@Workflow`-decorated class.

```js
// eslint.config.js
import durable from '@dudousxd/nestjs-durable-eslint-plugin';

export default [
  {
    files: ['**/*.ts'],
    plugins: { '@dudousxd/nestjs-durable': durable },
    rules: { '@dudousxd/nestjs-durable/no-nondeterminism': 'error' },
  },
];
// or: export default [durable.configs.recommended]
```

## Biome (>= 2.0) — GritQL plugin

Biome plugins can't yet scope by decorator/method, so target the plugin at your workflow files via
`overrides`:

```jsonc
// biome.json
{
  "overrides": [
    {
      "include": ["**/*.workflow.ts"],
      "plugins": ["./node_modules/@dudousxd/nestjs-durable-eslint-plugin/grit/no-nondeterminism.grit"]
    }
  ]
}
```

> The deterministic escape hatches `ctx.now()` / `ctx.random()` / `ctx.uuid()` already exist in
> `@dudousxd/nestjs-durable-core`; this rule pushes you to them at author time instead of finding the
> drift at replay (`NonDeterminismError`).
