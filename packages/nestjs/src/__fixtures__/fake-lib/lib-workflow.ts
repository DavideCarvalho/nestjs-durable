import { Injectable } from '@nestjs/common';
import { Workflow } from '../../decorators';

/**
 * Stands in for a workflow shipped by another package: it is declared under a directory with its own
 * `package.json`, so its derived origin is `@fixture/fake-lib` and NOT `@dudousxd/nestjs-durable`
 * (which owns the `@Workflow` decorator that captured the declaration). It opts into nothing — no
 * tags, no origin option — which is the entire point.
 */
@Workflow({ name: 'fake-lib-job', version: '1' })
@Injectable()
export class FakeLibWorkflow {
  async run(): Promise<string> {
    return 'ok';
  }
}
