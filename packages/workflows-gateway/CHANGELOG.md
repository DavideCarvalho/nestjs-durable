# @dudousxd/nestjs-durable-workflows-gateway

## 0.1.0

### Minor Changes

- [#444](https://github.com/DavideCarvalho/nestjs-durable/pull/444) [`34342e2`](https://github.com/DavideCarvalho/nestjs-durable/commit/34342e2dcd808307e5d817f3a061db61e5c45068) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The durable dashboard over the official `@nestjs/workflows` engine. New package `@dudousxd/nestjs-durable-workflows-gateway`: `DurableWorkflowsGatewayModule.forRoot()` binds `RunGateway` to `WorkflowClient` (list, detail with the journal as a timeline, children, waits, status counts, retry, cancel = `client.cancel`, plain cancel = `client.terminate`, fix-and-replay) and `WorkflowEvents` (live updates).

  Core: `DurableTopology` gains optional `engine` and `capabilities` (`ConsoleCapabilities`: a `false` key marks a console feature the gateway cannot serve). Dashboard: the SPA hides what a gateway marks unsupported (search-attribute, tag, namespace and origin filters, Continue, Re-dispatch, republish, schedules, workers) and shows the engine in the header. Durable's own gateways send no capabilities, so nothing changes for them.
