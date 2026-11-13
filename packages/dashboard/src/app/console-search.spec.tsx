// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSearch, isSearchShortcut, sanitizeSearch } from './ConsoleSearch';
import { ConsoleSwitcher, resetSwitcherCache } from './ConsoleSwitcher';

const ANSWER = {
  version: 1,
  q: 'run',
  partial: true,
  results: [
    {
      id: 'durable',
      title: 'Workflows',
      icon: 'workflow',
      hits: [
        { title: 'run-1', subtitle: 'run · checkout · failed', href: '/durable#/run/run-1' },
        { title: 'evil', href: 'https://evil.example' },
      ],
    },
    { id: 'media', title: 'Media', icon: 'nope', hits: [{ title: 'run.png', href: '/media#/f' }] },
    { id: 'empty', title: 'Empty', icon: 'generic', hits: [{ title: 'x', href: '//evil' }] },
  ],
};

function serve(handler: (url: string) => unknown) {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(handler(url))));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settle(ms = 200) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetSwitcherCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sanitizeSearch', () => {
  it('keeps safe hits, drops unsafe ones and consoles left empty, reads partial', () => {
    expect(sanitizeSearch(ANSWER)).toEqual({
      partial: true,
      groups: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [
            { title: 'run-1', subtitle: 'run · checkout · failed', href: '/durable#/run/run-1' },
          ],
        },
        {
          id: 'media',
          title: 'Media',
          icon: 'generic',
          hits: [{ title: 'run.png', href: '/media#/f' }],
        },
      ],
    });
    expect(sanitizeSearch(null)).toEqual({ groups: [], partial: false });
  });

  it('recognizes Ctrl-K and Cmd-K only', () => {
    expect(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSearchShortcut({ key: 'K', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSearchShortcut({ key: 'k', ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('ConsoleSearch', () => {
  it('searches as you type, groups hits per console, opens one with Enter', async () => {
    const fetchMock = serve(() => ANSWER);
    const navigate = vi.fn();
    const onClose = vi.fn();
    render(
      <ConsoleSearch
        endpoint="/durable/api/consoles/search"
        onClose={onClose}
        navigate={navigate}
      />,
    );
    const input = screen.getByRole('searchbox', { name: 'Search all consoles' });
    fireEvent.change(input, { target: { value: 'run' } });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/durable/api/consoles/search?q=run');
    expect(screen.getByRole('region', { name: 'Workflows' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Media' })).toBeTruthy();
    expect(screen.queryByText('evil')).toBeNull();
    expect(screen.getByText(/didn’t answer in time/)).toBeTruthy();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/media#/f');
  });

  it('closes on Escape and asks nothing for a blank query', async () => {
    const fetchMock = serve(() => ANSWER);
    const onClose = vi.fn();
    render(<ConsoleSearch endpoint="/s" onClose={onClose} navigate={vi.fn()} />);
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: '   ' } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the switcher opens the search', () => {
  it('on Ctrl-K, against <endpoint>/search', async () => {
    const fetchMock = serve((url) =>
      url.includes('/search')
        ? ANSWER
        : {
            version: 1,
            current: 'durable',
            consoles: [{ id: 'media', title: 'Media', icon: 'media', href: '/media' }],
          },
    );
    render(
      <ConsoleSwitcher
        brand={<span>durable</span>}
        current={{ title: 'Workflows', icon: 'workflow' }}
        config={{ endpoint: '/durable/api/consoles', others: 1 }}
      />,
    );
    await settle(0);
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'run' } });
    await settle();
    expect(fetchMock.mock.calls.map((call) => call[0])).toContain(
      '/durable/api/consoles/search?q=run',
    );
  });

  it('from the menu', async () => {
    serve(() => ({
      version: 1,
      current: 'durable',
      consoles: [{ id: 'media', title: 'Media', icon: 'media', href: '/media' }],
    }));
    render(
      <ConsoleSwitcher
        brand={<span>durable</span>}
        current={{ title: 'Workflows', icon: 'workflow' }}
        config={{ endpoint: '/durable/api/consoles', others: 1 }}
      />,
    );
    await settle(0);
    fireEvent.click(screen.getByRole('button', { name: 'Workflows: switch console' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Search all consoles/ }));
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });
});
