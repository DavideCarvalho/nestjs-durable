# @dudousxd/nestjs-durable-workflows-gateway

## 0.2.0

### Minor Changes

- [#458](https://github.com/DavideCarvalho/nestjs-durable/pull/458) [`196b2d2`](https://github.com/DavideCarvalho/nestjs-durable/commit/196b2d26006898943468ced8336bde3ae128caf4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`, `>=22`, or unset). CI tests on Node 24 and 26, and builds and releases on Node 24. Upgrade Node, then the packages.

  Removed, with no alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-durable-core`: `RunSchedulesOptions.sleep`, which was no longer called, and the `InternalWorkflowCtx` type (use `WorkflowCtx`).
  - `@dudousxd/nestjs-durable`: `@DurableStep` (use `@Step`), `@OnEvent` (use `@OnDurableEvent`), and `@Workflow({ inputSchema })` (use `input`).
  - `@dudousxd/nestjs-durable-dashboard`: `RUN_GATEWAY`.

  Still exported, deprecated, because published releases of sibling packages import them: `RUN_GATEWAY` from `@dudousxd/nestjs-durable` (it is the `RunGateway` class), and `STATE_STORE`, `TRANSPORT` and `DURABLE_OPTIONS` from `@dudousxd/nestjs-durable-core` (`DurableModule` binds them to the same instances as the `*_CANONICAL` tokens). New code should inject `RunGateway` and the `*_CANONICAL` tokens.

  Fixed: the dual ESM/CJS packages could publish without `index.d.cts`. Their ESM and CJS tsup builds run in parallel, and the cleaning one's declaration step deleted the other's output. `dist` is now cleaned once, before both builds. `@dudousxd/nestjs-durable-eslint-plugin` exports `meta` as a named export too, so an ESM `import durable from …` of the CommonJS plugin carries it.

## 0.1.0

### Minor Changes

- [#444](https://github.com/DavideCarvalho/nestjs-durable/pull/444) [`34342e2`](https://github.com/DavideCarvalho/nestjs-durable/commit/34342e2dcd808307e5d817f3a061db61e5c45068) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The durable dashboard over the official `@nestjs/workflows` engine. New package `@dudousxd/nestjs-durable-workflows-gateway`: `DurableWorkflowsGatewayModule.forRoot()` binds `RunGateway` to `WorkflowClient` (list, detail with the journal as a timeline, children, waits, status counts, retry, cancel = `client.cancel`, plain cancel = `client.terminate`, fix-and-replay) and `WorkflowEvents` (live updates).

  Core: `DurableTopology` gains optional `engine` and `capabilities` (`ConsoleCapabilities`: a `false` key marks a console feature the gateway cannot serve). Dashboard: the SPA hides what a gateway marks unsupported (search-attribute, tag, namespace and origin filters, Continue, Re-dispatch, republish, schedules, workers) and shows the engine in the header. Durable's own gateways send no capabilities, so nothing changes for them.
