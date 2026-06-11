import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { DurableModule } from './durable.module';

class SchemaSpyStore extends InMemoryStateStore {
  ensured = 0;
  async ensureSchema(): Promise<void> {
    this.ensured += 1;
  }
}

describe('autoSchema', () => {
  it('calls store.ensureSchema on boot by default', async () => {
    const store = new SchemaSpyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
    }).compile();
    await moduleRef.init();
    expect(store.ensured).toBe(1);
  });

  it('does not call ensureSchema when autoSchema is false', async () => {
    const store = new SchemaSpyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, autoSchema: false })],
    }).compile();
    await moduleRef.init();
    expect(store.ensured).toBe(0);
  });
});
