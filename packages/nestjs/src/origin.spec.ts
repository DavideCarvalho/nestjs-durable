import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Injectable, Module, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLibWorkflow } from './__fixtures__/fake-lib/lib-workflow';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { originOfClass, originOfProvider } from './origin';
import { WorkflowService } from './workflow.service';

/** This spec lives in `packages/nestjs/src`, so every class declared here is owned by this package. */
const THIS_PACKAGE = '@dudousxd/nestjs-durable';

@Workflow({ name: 'attributed', version: '1' })
class AttributedWorkflow {
  async run() {
    return 'ok';
  }
}

/** A lib-shaped provider: declared in its own module, imported by the app. */
@Workflow({ name: 'from-lib', version: '1' })
@Injectable()
class LibWorkflow {
  async run() {
    return 'ok';
  }
}

@Module({ providers: [LibWorkflow], exports: [LibWorkflow] })
class LibModule {}

/** Inherits its `@Workflow` metadata — and so its origin — from the decorated base class. */
class InheritedWorkflow extends AttributedWorkflow {}

/**
 * A workflow declared on a runtime that hands back no usable stack frame (here: `stackTraceLimit = 0`,
 * the same shape as a non-V8 runtime). The class is real and registers normally — it just cannot be
 * attributed.
 */
function declareUnattributable(): new () => { run(): Promise<string> } {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    const cls = class {
      async run() {
        return 'ok';
      }
    };
    Workflow({ name: 'unattributable', version: '1' })(cls);
    return cls;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

const UnattributableWorkflow = declareUnattributable();

async function bootWith(providers: Provider[], store: InMemoryStateStore) {
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 })],
    providers,
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('workflow origin derivation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives the declaring package for a workflow the app registers directly', () => {
    expect(originOfClass(AttributedWorkflow)).toBe(THIS_PACKAGE);
  });

  it('derives it from a provider wrapper, by metatype or by instance', () => {
    expect(originOfProvider({ metatype: LibWorkflow })).toBe(THIS_PACKAGE);
    expect(originOfProvider({ instance: new LibWorkflow() })).toBe(THIS_PACKAGE);
  });

  it('attributes a workflow to the package that DECLARED it, not to this one', async () => {
    // `FakeLibWorkflow` is declared under a directory carrying its own package.json, exactly as an
    // installed lib is. Nothing about it opts in — it is a plain `@Workflow` — yet it is attributed
    // to its own package rather than to whoever owns the decorator or the app that registers it.
    expect(originOfClass(FakeLibWorkflow)).toBe('@fixture/fake-lib');

    const store = new InMemoryStateStore();
    const moduleRef = await bootWith([FakeLibWorkflow], store);
    await moduleRef.get(WorkflowService).start('fake-lib-job', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBe('@fixture/fake-lib');
    expect((await store.listRuns({ origin: THIS_PACKAGE })).map((r) => r.id)).toEqual([]);
  });

  it('carries the base class origin onto a subclass that inherits @Workflow metadata', () => {
    expect(originOfClass(InheritedWorkflow)).toBe(THIS_PACKAGE);
  });

  it('returns undefined — never a fallback — when no declaring file was captured', () => {
    expect(originOfClass(UnattributableWorkflow)).toBeUndefined();
    expect(originOfClass(class Undecorated {})).toBeUndefined();
    expect(originOfProvider({})).toBeUndefined();
  });

  it('stamps the derived origin onto runs, with no opt-in from the workflow', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await bootWith([AttributedWorkflow], store);

    await moduleRef.get(WorkflowService).start('attributed', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBe(THIS_PACKAGE);
    expect((await store.listRuns({ origin: THIS_PACKAGE })).map((r) => r.id)).toEqual(['r1']);
  });

  it('attributes a workflow that arrives through an imported module, not the app module', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
        LibModule,
      ],
    }).compile();
    await moduleRef.init();

    await moduleRef.get(WorkflowService).start('from-lib', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBe(THIS_PACKAGE);
  });

  it('leaves an unattributable workflow with no origin and says so at boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const moduleRef = await bootWith([UnattributableWorkflow], store);

    await moduleRef.get(WorkflowService).start('unattributable', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBeUndefined();
    const warned = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(warned).toContain('could not derive an origin');
    expect(warned).toContain('unattributable');
  });

  it('says nothing at boot when every workflow was attributed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    await bootWith([AttributedWorkflow], store);

    const warned = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(warned).not.toContain('could not derive an origin');
  });
});
