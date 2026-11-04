// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowLifecycleLinks } from '../client/durable-client';
import {
  WorkflowLifecycleLists,
  subscriptionTraits,
  triggerCountLabel,
  workflowFromHash,
  workflowHash,
} from './WorkflowLifecycle';

// No jest-dom in this package (see `open-console.spec.tsx`): assertions read plain DOM properties.

afterEach(cleanup);

const links: WorkflowLifecycleLinks = {
  workflow: 'ingest',
  startsOnSettle: [
    {
      workflow: 'notify',
      kind: 'failed',
      local: false,
      announced: true,
      where: false,
      input: false,
    },
    {
      workflow: 'refresh base',
      kind: 'completed',
      local: true,
      announced: false,
      where: true,
      input: true,
      coalesce: { mode: 'debounce', keyed: true },
    },
  ],
  startedBy: [
    {
      workflow: 'upload',
      kind: 'completed',
      local: true,
      announced: true,
      where: false,
      input: false,
    },
  ],
};

function rows(title: string): { name: string; href: string; chips: string[] }[] {
  const section = screen.getByRole('region', { name: title });
  return within(section)
    .getAllByRole('listitem')
    .map((li) => {
      const link = li.querySelector('a');
      return {
        name: link?.textContent ?? '',
        href: link?.getAttribute('href') ?? '',
        chips: [...li.querySelectorAll('span')].map((chip) => chip.textContent ?? ''),
      };
    });
}

describe('<WorkflowLifecycleLists>', () => {
  it('lists who starts when the workflow settles, with what each subscription does', () => {
    render(<WorkflowLifecycleLists links={links} />);

    expect(rows('Starts when it settles')).toEqual([
      { name: 'notify', href: '#/workflow/notify', chips: ['on failed', 'announced'] },
      {
        name: 'refresh base',
        href: '#/workflow/refresh%20base',
        chips: ['on completed', 'where', 'input', 'debounce by key'],
      },
    ]);
  });

  it('lists the workflows whose settling starts it, each linking to its page', () => {
    render(<WorkflowLifecycleLists links={links} />);

    expect(rows('Started by')).toEqual([
      { name: 'upload', href: '#/workflow/upload', chips: ['on completed'] },
    ]);
  });

  it('says so when a list is empty', () => {
    render(
      <WorkflowLifecycleLists links={{ workflow: 'alone', startsOnSettle: [], startedBy: [] }} />,
    );

    const section = screen.getByRole('region', { name: 'Started by' });
    expect(section.textContent).toContain("No workflow's settling starts it.");
    expect(within(section).queryAllByRole('listitem')).toEqual([]);
  });
});

describe('workflow page hash', () => {
  it('round-trips any workflow name', () => {
    for (const name of ['ingest', 'orders:fulfill', 'a b/c#d']) {
      expect(workflowFromHash(workflowHash(name))).toBe(name);
    }
    expect(workflowFromHash('#/run/r1')).toBeUndefined();
  });

  it('names a batch without a key plainly', () => {
    expect(
      subscriptionTraits({
        workflow: 'x',
        kind: 'completed',
        local: true,
        announced: false,
        where: false,
        input: false,
        coalesce: { mode: 'batch', keyed: false },
      }),
    ).toEqual(['batch']);
  });
});

describe('trigger counts on the workflow page', () => {
  it('adds the started and failed counts to each subscriber that settling starts', () => {
    render(
      <WorkflowLifecycleLists
        links={links}
        counts={{
          notify: { triggered: 4, failed: 1 },
          'refresh base': { triggered: 0, failed: 0 },
        }}
      />,
    );

    expect(rows('Starts when it settles').map((row) => row.chips)).toEqual([
      ['on failed', 'announced', '4 started · 1 failed'],
      ['on completed', 'where', 'input', 'debounce by key', '0 started'],
    ]);
    expect(rows('Started by').map((row) => row.chips)).toEqual([['on completed']]);
  });

  it('draws no counts when the server keeps none', () => {
    expect(triggerCountLabel(undefined, 'notify')).toBeUndefined();
  });
});
