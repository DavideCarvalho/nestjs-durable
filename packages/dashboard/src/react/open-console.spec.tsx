// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenDurableConsoleButton } from './open-console-button.js';
import { openDurableConsoleMutationOptions } from './use-open-console.js';

function response(init: { status?: number; type?: string } = {}): Response {
  const status = init.status ?? 204;
  return { ok: status >= 200 && status < 300, status, type: init.type ?? 'basic' } as Response;
}

/**
 * A `pageshow` event with the `persisted` flag browsers set only on a back/forward-cache restore.
 *
 * Built by hand rather than via `new PageTransitionEvent('pageshow', { persisted })`: happy-dom
 * exposes the constructor but drops the `persisted` init (it reads back `undefined`), which would
 * make every assertion below pass for the wrong reason.
 */
function pageshow(persisted: boolean): Event {
  return Object.assign(new Event('pageshow'), { persisted });
}

describe('openDurableConsoleMutationOptions', () => {
  it('returns a useMutation-shaped object without depending on TanStack', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    const options = openDurableConsoleMutationOptions({ fetch: fetchMock, navigate });

    // The point of the shape: a host passes this straight into `useMutation`, and this package
    // never imports @tanstack/react-query — so a host that doesn't use Query pays nothing.
    expect(options.mutationKey).toEqual(['durable', 'console', 'open', null]);
    await options.mutationFn();
    expect(navigate).toHaveBeenCalledWith('/durable');
  });

  it('keys by basePath so two mounts do not share cache state', () => {
    expect(openDurableConsoleMutationOptions({ basePath: '/ops' }).mutationKey).toEqual([
      'durable',
      'console',
      'open',
      '/ops',
    ]);
  });
});

describe('<OpenDurableConsoleButton>', () => {
  it('mints and navigates on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenDurableConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/durable'));
  });

  it('surfaces a refusal instead of failing silently', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenDurableConsoleButton fetch={fetchMock} navigate={vi.fn()} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // A button that silently does nothing reads as broken rather than forbidden — the single most
    // important behaviour for a launcher, and the reason the error renders by default.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 403/));
  });

  it('does not navigate when the mint is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 401 }));
    const navigate = vi.fn();
    render(<OpenDurableConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders a custom error node when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(
      <OpenDurableConsoleButton
        fetch={fetchMock}
        navigate={vi.fn()}
        renderError={(error) => <span data-testid="mine">{error.message}</span>}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByTestId('mine')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing for the error when renderError is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenDurableConsoleButton fetch={fetchMock} navigate={vi.fn()} renderError={null} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // Opting out entirely must be possible for a host that surfaces errors its own way (a toast).
    await waitFor(() =>
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forwards button props so it inherits the host design system', () => {
    render(
      <OpenDurableConsoleButton
        className="btn btn-primary"
        data-testid="launcher"
        title="Open it"
      />,
    );

    // Unstyled-and-forwarding is the whole reason this ships no CSS.
    const button = screen.getByTestId('launcher');
    expect(button.className).toBe('btn btn-primary');
    expect(button.getAttribute('title')).toBe('Open it');
  });

  it('disables itself while in flight', async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(<OpenDurableConsoleButton fetch={fetchMock} navigate={vi.fn()} />);
    const button = screen.getByRole('button');

    await act(async () => {
      button.click();
    });

    // Without this a double-click fires two mints, and the second can land after the navigation.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      release(response());
    });
  });
});

describe('<OpenDurableConsoleButton> across a back/forward-cache restore', () => {
  async function mintSuccessfully() {
    const navigate = vi.fn();
    const view = render(
      <OpenDurableConsoleButton
        fetch={vi.fn().mockResolvedValue(response())}
        navigate={navigate}
      />,
    );
    const button = screen.getByRole('button') as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/durable'));

    return { button, view };
  }

  it('stays busy right after a successful mint', async () => {
    const { button } = await mintSuccessfully();

    // The anti-flicker guarantee, pinned: the navigation is already underway, so flipping the
    // button back to idle would show "ready to click again" on a page that is leaving.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('goes idle again when the page is restored from the back/forward cache', async () => {
    const { button } = await mintSuccessfully();

    await act(async () => {
      window.dispatchEvent(pageshow(true));
    });

    // The page did not die after all — the user pressed Back and got this component restored from
    // memory with its state intact. Without this the launcher is a permanent spinner on a button
    // that can no longer be clicked.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('ignores a pageshow that is not a restore', async () => {
    const { button } = await mintSuccessfully();

    await act(async () => {
      window.dispatchEvent(pageshow(false));
    });

    // `persisted: false` is an ordinary load. Reacting to it would undo the anti-flicker behaviour
    // on the very navigation that is still in progress.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('removes its pageshow listener on unmount', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const { view } = await mintSuccessfully();

    const added = addEventListener.mock.calls.find(([type]) => type === 'pageshow');
    expect(added).toBeDefined();

    view.unmount();

    const removed = removeEventListener.mock.calls.find(([type]) => type === 'pageshow');
    // Same handler identity: removing a *different* function leaves the original attached, which
    // leaks a listener that would then setState on an unmounted component.
    expect(removed?.[1]).toBe(added?.[1]);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      window.dispatchEvent(pageshow(true));
    });
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });
});
