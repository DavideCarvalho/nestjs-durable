import type { ArgumentsHost } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import {
  DashboardSessionRequiredException,
  DashboardSessionRequiredFilter,
} from './session-required.exception.js';

/**
 * Minimal stand-in for the Node `ServerResponse` surface the raw writers in `response.ts` use
 * (`statusCode`, `setHeader`, `end`) plus the `headersSent` flag they consult. A real Express app is
 * overkill here: what matters is which writer wins and whether the request is left hanging.
 */
function responseStub() {
  const headers: Record<string, string | string[]> = {};
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined as string | undefined,
    getHeader(name: string) {
      return headers[name];
    },
    setHeader(name: string, value: string | string[]) {
      headers[name] = value;
    },
    end(chunk?: string) {
      this.headersSent = true;
      this.body = chunk;
    },
  };
}

function hostFor(response: unknown, request: unknown = { url: '/durable' }): ArgumentsHost {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function authWith(
  unauthenticatedPage: ResolvedDashboardAuth['unauthenticatedPage'],
): ResolvedDashboardAuth {
  return { secret: 's'.repeat(32), ttlMs: 1000, modes: ['session'], unauthenticatedPage };
}

describe('DashboardSessionRequiredFilter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the built-in page when no host page is configured', async () => {
    const response = responseStub();
    await new DashboardSessionRequiredFilter().catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Open this console from your application');
  });

  it('hands the response to the host page and writes nothing of its own', async () => {
    const response = responseStub();
    const unauthenticatedPage = vi.fn((ctx: { response: unknown }) => {
      const res = ctx.response as ReturnType<typeof responseStub>;
      res.statusCode = 401;
      res.end('<html>host page</html>');
    });

    await new DashboardSessionRequiredFilter(authWith(unauthenticatedPage)).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    // The whole point: the host's bytes reach the browser, at the console's own URL, and the
    // built-in card is nowhere in the response.
    expect(response.body).toBe('<html>host page</html>');
    expect(response.body).not.toContain('Open this console from your application');
    expect(unauthenticatedPage).toHaveBeenCalledOnce();
  });

  it('passes the request, response and basePath to the host page', async () => {
    const response = responseStub();
    const request = { url: '/durable', headers: {} };
    const unauthenticatedPage = vi.fn((ctx: { response: unknown }) => {
      (ctx.response as ReturnType<typeof responseStub>).end('ok');
    });

    await new DashboardSessionRequiredFilter(authWith(unauthenticatedPage)).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response, request),
    );

    expect(unauthenticatedPage).toHaveBeenCalledWith({ request, response, basePath: '/durable' });
  });

  it('awaits an async host page instead of racing it', async () => {
    const response = responseStub();
    const unauthenticatedPage = async (ctx: { response: unknown }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      (ctx.response as ReturnType<typeof responseStub>).end('<html>async host page</html>');
    };

    await new DashboardSessionRequiredFilter(authWith(unauthenticatedPage)).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    // Without the await, the filter would see an unwritten response and overwrite the host's page
    // with the built-in card the moment the hook yielded — the single most likely way to get this
    // wrong, and invisible with a synchronous hook.
    expect(response.body).toBe('<html>async host page</html>');
  });

  it('falls back to the built-in page when the host page throws', async () => {
    const response = responseStub();
    const unauthenticatedPage = () => {
      throw new Error('template blew up');
    };

    await new DashboardSessionRequiredFilter(authWith(unauthenticatedPage)).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    // A broken host page must not turn a denial into a 500 — and above all must not open the
    // console. The user still gets a page, and it is still a 401.
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Open this console from your application');
  });

  it('falls back to the built-in page when the host page writes nothing', async () => {
    const response = responseStub();

    await new DashboardSessionRequiredFilter(authWith(() => {})).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    // Otherwise the request hangs until the browser gives up, with nothing logged anywhere.
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Open this console from your application');
  });

  it('does not write twice when the host page throws after writing', async () => {
    const response = responseStub();
    const unauthenticatedPage = (ctx: { response: unknown }) => {
      (ctx.response as ReturnType<typeof responseStub>).end('<html>partial</html>');
      throw new Error('threw after writing');
    };

    await new DashboardSessionRequiredFilter(authWith(unauthenticatedPage)).catch(
      new DashboardSessionRequiredException('/durable'),
      hostFor(response),
    );

    // A second write here is ERR_HTTP_HEADERS_SENT stacked on top of the host's own error.
    expect(response.body).toBe('<html>partial</html>');
  });
});
