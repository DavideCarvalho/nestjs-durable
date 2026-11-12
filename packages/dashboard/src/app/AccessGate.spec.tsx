// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from '../client/durable-client';
import { AccessGate } from './AccessGate';

afterEach(() => vi.unstubAllGlobals());

function refuse(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'x' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('AccessGate', () => {
  it('renders the console until the API refuses access', () => {
    render(
      <AccessGate>
        <p>console</p>
      </AccessGate>,
    );
    expect(screen.getByText('console')).toBeTruthy();
  });

  it.each([
    [403, 'Access denied'],
    [401, 'Sign in required'],
  ])('a %i replaces the console with "%s"', async (status, heading) => {
    render(
      <AccessGate>
        <p>console</p>
      </AccessGate>,
    );
    refuse(status);
    await act(async () => {
      await durableClient.runs().catch(() => undefined);
    });
    expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.queryByText('console')).toBeNull();
  });
});
