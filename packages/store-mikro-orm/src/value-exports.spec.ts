import { EntityRepository } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as repositories from './repositories';

/**
 * The repository classes are the one thing in this package a host app uses as a VALUE: it injects
 * them by type, and MikroORM instantiates them per `em.getRepository`. Moving them into an
 * `export type { … }` block in `index.ts` is invisible to every other gate — `tsc` is green (the
 * `.d.ts` rollup drops the `type` modifier, so the name still looks like a value to consumers),
 * `tsup` is green, and nothing fails until a consumer resolves the symbol at runtime and gets
 * `undefined`. That has shipped before in this repo, with core's `RunGateway`.
 */
describe('barrel re-exports keep the repository classes as VALUES', () => {
  const repositoryNames = Object.keys(repositories).filter(
    (name) => typeof (repositories as Record<string, unknown>)[name] === 'function',
  );

  it('exposes one repository per durable entity (guards the guard)', () => {
    expect(repositoryNames.sort()).toEqual([
      'BufferedEventRepository',
      'BufferedSignalRepository',
      'RunAttributeRepository',
      'SignalWaiterRepository',
      'StepCheckpointRepository',
      'WorkflowRunRepository',
    ]);
  });

  it.each([
    'WorkflowRunRepository',
    'StepCheckpointRepository',
    'RunAttributeRepository',
    'SignalWaiterRepository',
    'BufferedSignalRepository',
    'BufferedEventRepository',
  ])('%s is re-exported as a value, not a type', (name) => {
    const exported = (barrel as Record<string, unknown>)[name];
    expect(
      exported,
      `${name} is undefined at runtime — moved into an \`export type\` block?`,
    ).toBeDefined();
    expect(exported).toBe((repositories as Record<string, unknown>)[name]);
  });

  it.each(repositoryNames)('%s extends EntityRepository', (name) => {
    const cls = (repositories as Record<string, unknown>)[name] as new (
      ...args: never[]
    ) => unknown;
    expect(Object.getPrototypeOf(cls)).toBe(EntityRepository);
  });
});
