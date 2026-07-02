import {
  type Heartbeat,
  InMemoryStateStore,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { DurableModule } from './durable.module';

/**
 * A broker-like transport whose `onRunRequest`/`publishRunReply` are real class methods that touch a
 * PRIVATE field — exactly like the shipped `BullMQTransport` (`this.#runRequestName()`). If the
 * operator bootstrap hands these methods to the `RunRequestResponder` UNBOUND (destructured off the
 * instance), calling them later runs with the wrong `this` and V8 throws
 * "Receiver must be an instance of class …" the moment the private field is accessed. This fixture
 * reproduces that: `runRequestStarted` can only flip to `true` if `onRunRequest` ran with the
 * transport as its receiver.
 */
class BrokerTransport implements Transport {
  readonly dispatchedGroups: string[] = [];
  #runRequestStarted = false;
  #decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return ['processing'];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatchedGroups.push(task.group);
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.#decisionHandler = handler;
  }

  // The two broker-only run-gateway methods, each touching a private field so a wrong receiver throws.
  onRunRequest(_handler: (msg: unknown) => Promise<void>): void {
    this.#runRequestStarted = true;
  }

  async publishRunReply(_reply: unknown): Promise<void> {
    if (!this.#runRequestStarted) return;
  }

  get runRequestStarted(): boolean {
    return this.#runRequestStarted;
  }
}

describe('RunGatewayBootstrap (operator responder wiring)', () => {
  it('starts the run-request responder against the transport as receiver (methods stay bound)', async () => {
    const store = new InMemoryStateStore();
    const transport = new BrokerTransport();

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport, drive: true })],
    }).compile();

    // Before the fix this throws "Receiver must be an instance of class BrokerTransport" — the
    // responder called an UNBOUND `onRunRequest`, so `this.#runRequestStarted = true` had no receiver.
    await moduleRef.init();

    expect(transport.runRequestStarted).toBe(true);

    await moduleRef.close();
  });
});
