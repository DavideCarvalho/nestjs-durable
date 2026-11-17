// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from '../client/durable-client';
import { AppSelector, appHref } from './AppSelector';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('appHref', () => {
  it('sets or drops ?app= and keeps the other params, without the hash', () => {
    expect(appHref('orders', { pathname: '/durable', search: '' })).toBe('/durable?app=orders');
    expect(appHref('', { pathname: '/durable', search: '?app=orders&x=1' })).toBe('/durable?x=1');
    expect(appHref('', { pathname: '/durable', search: '?app=orders' })).toBe('/durable');
  });
});

function renderSelector() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppSelector />
    </QueryClientProvider>,
  );
}

describe('AppSelector', () => {
  it('renders nothing on a console without federation', async () => {
    vi.spyOn(durableClient, 'topology').mockResolvedValue({ role: 'control-plane' });
    const { container } = renderSelector();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });

  it('lists the local app and the federated ones, selecting the one in the URL', async () => {
    window.history.replaceState(null, '', '/durable?app=b');
    vi.spyOn(durableClient, 'topology').mockResolvedValue({
      role: 'control-plane',
      federation: {
        local: { label: 'Hub' },
        apps: [
          { name: 'a', label: 'Orders' },
          { name: 'b', label: 'Billing' },
        ],
        current: 'b',
      },
    });
    renderSelector();
    const select = (await screen.findByLabelText('App')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Hub', 'Orders', 'Billing']);
    expect(select.value).toBe('b');
  });

  it('sends the selected app with every API call', async () => {
    window.history.replaceState(null, '', '/durable?app=a');
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ role: 'control-plane' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await durableClient.topology();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-durable-app')).toBe('a');
  });
});
