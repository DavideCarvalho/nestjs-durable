import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { parseCookieHeader } from './auth/cookie-header';
import { resolveDashboardAuth } from './auth/dashboard-auth-config';
import { verifySessionCookie } from './auth/session-cookie';
import { DurableAuthController } from './durable-auth.controller';

const SECRET = 'controller-spec-secret-key-0123456789';
const BASE_PATH = '/durable';

/** Minimal Node-response double recording Set-Cookie writes. */
function makeResponse(): {
  raw: {
    statusCode: number;
    getHeader: (n: string) => unknown;
    setHeader: (n: string, v: unknown) => void;
    end: () => void;
  };
  setCookies: () => string[];
  location: () => unknown;
  ended: () => boolean;
} {
  const headers: Record<string, unknown> = {};
  let ended = false;
  const raw = {
    statusCode: 200,
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: unknown) => {
      headers[name.toLowerCase()] = value;
    },
    end: () => {
      ended = true;
    },
  };
  return {
    raw,
    setCookies: () => {
      const current = headers['set-cookie'];
      return Array.isArray(current)
        ? current.filter((c): c is string => typeof c === 'string')
        : [];
    },
    location: () => headers.location,
    ended: () => ended,
  };
}

describe('DurableAuthController (absent-option)', () => {
  const controller = new DurableAuthController(null, BASE_PATH);

  it('404s the login page when dashboardAuth is not configured', () => {
    expect(() => controller.loginPage()).toThrow(NotFoundException);
  });

  it('404s POST login when dashboardAuth is not configured', async () => {
    await expect(
      controller.login({ username: 'a', password: 'b' }, { headers: {} }, makeResponse().raw),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still clears the cookie on logout even without dashboardAuth (harmless best-effort)', () => {
    const response = makeResponse();
    controller.logout({ headers: {} }, response.raw);
    expect(response.setCookies().some((c) => c.startsWith('durable_dashboard_session=;'))).toBe(
      true,
    );
  });
});

describe('DurableAuthController (dashboardAuth configured)', () => {
  const users: Record<string, { id: string; roles: string[] }> = {
    ops: { id: 'ops', roles: ['admin'] },
  };
  const auth = resolveDashboardAuth({
    secret: SECRET,
    login: (username, password) =>
      users[username] && password === 'correct-horse' ? users[username] : null,
  });
  const controller = new DurableAuthController(auth, BASE_PATH);

  it('renders the login page', () => {
    const html = controller.loginPage();
    expect(html).toContain('<form');
    expect(html).toContain('/durable/login');
  });

  it('round-trip: a successful login mints a cookie the session verifier accepts', async () => {
    const response = makeResponse();
    const result = await controller.login(
      { username: 'ops', password: 'correct-horse', returnTo: '/durable/runs/1' },
      { headers: {} },
      response.raw,
    );

    expect(result).toEqual({ redirectTo: '/durable/runs/1' });
    const cookieValue = parseCookieHeader(response.setCookies()[0]).durable_dashboard_session;
    expect(cookieValue).toBeDefined();
    const session = verifySessionCookie(cookieValue ?? '', { secret: SECRET });
    expect(session).toMatchObject({ sub: 'ops', roles: ['admin'] });
  });

  it('sanitizes an unsafe returnTo to basePath (open-redirect guard)', async () => {
    const response = makeResponse();
    const result = await controller.login(
      { username: 'ops', password: 'correct-horse', returnTo: 'https://evil.example/phish' },
      { headers: {} },
      response.raw,
    );
    expect(result).toEqual({ redirectTo: BASE_PATH });
  });

  it('uniform failure: an unknown user gets the same 401 message as a wrong password', async () => {
    const unknownUser = controller
      .login({ username: 'nobody', password: 'whatever' }, { headers: {} }, makeResponse().raw)
      .catch((error) => error);
    const wrongPassword = controller
      .login({ username: 'ops', password: 'wrong' }, { headers: {} }, makeResponse().raw)
      .catch((error) => error);
    const [unknownError, wrongError] = await Promise.all([unknownUser, wrongPassword]);

    expect(unknownError).toBeInstanceOf(UnauthorizedException);
    expect(wrongError).toBeInstanceOf(UnauthorizedException);
    expect(unknownError.getResponse()).toEqual(wrongError.getResponse());
  });

  it('rejects a body missing username/password with 400', async () => {
    await expect(
      controller.login({ username: 'ops' }, { headers: {} }, makeResponse().raw),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a throwing login hook is treated as a denial, not a 500', async () => {
    const throwingAuth = resolveDashboardAuth({
      secret: SECRET,
      login: () => {
        throw new Error('db is down');
      },
    });
    const throwingController = new DurableAuthController(throwingAuth, BASE_PATH);
    await expect(
      throwingController.login(
        { username: 'ops', password: 'x' },
        { headers: {} },
        makeResponse().raw,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout clears the cookie and redirects to the login page', () => {
    const response = makeResponse();
    controller.logout({ headers: {} }, response.raw);
    expect(response.setCookies().some((c) => c.startsWith('durable_dashboard_session=;'))).toBe(
      true,
    );
    expect(response.raw.statusCode).toBe(302);
    expect(response.location()).toBe('/durable/login');
    expect(response.ended()).toBe(true);
  });
});

describe('DurableAuthController (password is optional end-to-end)', () => {
  // The password field has no HTML `required` and the controller passes it through AS-IS (empty
  // string when blank) — the `login` hook, not this controller, decides whether a password
  // matters. This is what lets an email-only host (gate on username, ignore password) work with
  // the same built-in login page as a host with real passwords.

  it('an empty password reaches the login hook verbatim', async () => {
    const loginSpy = vi.fn().mockReturnValue(null);
    const auth = resolveDashboardAuth({ secret: SECRET, login: loginSpy });
    const controller = new DurableAuthController(auth, BASE_PATH);

    await controller
      .login({ username: 'ops', password: '' }, { headers: {} }, makeResponse().raw)
      .catch(() => undefined);

    expect(loginSpy).toHaveBeenCalledWith('ops', '');
  });

  it('a hook rejecting an empty password still uniform-fails (generic 401)', async () => {
    const auth = resolveDashboardAuth({
      secret: SECRET,
      login: (username, password) =>
        username === 'ops' && password === 'real-password' ? { id: 'ops' } : null,
    });
    const controller = new DurableAuthController(auth, BASE_PATH);

    await expect(
      controller.login({ username: 'ops', password: '' }, { headers: {} }, makeResponse().raw),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a hook that accepts an empty password (username-only gating) mints the session', async () => {
    const auth = resolveDashboardAuth({
      secret: SECRET,
      login: (username) => (username === 'admin@example.com' ? { id: 'admin' } : null),
    });
    const controller = new DurableAuthController(auth, BASE_PATH);
    const response = makeResponse();

    const result = await controller.login(
      { username: 'admin@example.com', password: '' },
      { headers: {} },
      response.raw,
    );

    expect(result).toEqual({ redirectTo: BASE_PATH });
    const cookieValue = parseCookieHeader(response.setCookies()[0]).durable_dashboard_session;
    expect(verifySessionCookie(cookieValue ?? '', { secret: SECRET })).toMatchObject({
      sub: 'admin',
    });
  });
});

describe('DurableAuthController (Mode A — session hook)', () => {
  it('POST session mints the cookie when the host hook returns a user', async () => {
    const auth = resolveDashboardAuth({
      secret: SECRET,
      session: () => ({ id: '7', roles: ['admin'] }),
    });
    const controller = new DurableAuthController(auth, BASE_PATH);
    const response = makeResponse();

    await controller.session({ headers: {} }, response.raw);

    const cookieValue = parseCookieHeader(response.setCookies()[0]).durable_dashboard_session;
    expect(cookieValue).toBeDefined();
    const session = verifySessionCookie(cookieValue ?? '', { secret: SECRET });
    expect(session).toMatchObject({ sub: '7', roles: ['admin'] });
  });

  it('POST session 401s when the host hook denies', async () => {
    const auth = resolveDashboardAuth({ secret: SECRET, session: () => null });
    const controller = new DurableAuthController(auth, BASE_PATH);
    await expect(controller.session({ headers: {} }, makeResponse().raw)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('POST session 401s (not 500) when the host hook throws', async () => {
    const auth = resolveDashboardAuth({
      secret: SECRET,
      session: () => {
        throw new Error('db down');
      },
    });
    const controller = new DurableAuthController(auth, BASE_PATH);
    await expect(controller.session({ headers: {} }, makeResponse().raw)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('POST session 404s when only Mode B is configured', async () => {
    const auth = resolveDashboardAuth({ secret: SECRET, login: () => null });
    const controller = new DurableAuthController(auth, BASE_PATH);
    await expect(controller.session({ headers: {} }, makeResponse().raw)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('GET login 404s when only Mode A is configured', () => {
    const auth = resolveDashboardAuth({ secret: SECRET, session: () => null });
    const controller = new DurableAuthController(auth, BASE_PATH);
    expect(() => controller.loginPage()).toThrow(NotFoundException);
  });
});
