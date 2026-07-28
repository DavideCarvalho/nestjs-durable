import { describe, expect, it } from 'vitest';
import { renderLoginPage, renderSessionRequiredPage } from './login-page.js';

describe('renderLoginPage', () => {
  const html = renderLoginPage('/durable');

  it('keeps the "Sign in — Durable" title', () => {
    expect(html).toContain('<title>Sign in — Durable</title>');
  });

  it('requires username but leaves password optional (no HTML `required`)', () => {
    const usernameInput = html.match(/<input id="username"[^>]*>/)?.[0];
    const passwordInput = html.match(/<input id="password"[^>]*>/)?.[0];
    expect(usernameInput).toContain('required');
    expect(passwordInput).toBeDefined();
    expect(passwordInput).not.toContain('required');
  });

  it("mirrors agent-dashboard's dark zinc/emerald palette", () => {
    expect(html).toContain('#09090b');
    expect(html).toContain('#18181b');
    expect(html).toContain('#34d399');
    expect(html).toContain('ui-monospace');
  });
});

describe('renderSessionRequiredPage', () => {
  const html = renderSessionRequiredPage('/durable');

  it('keeps the shared "Durable" title (no form, so no "Sign in" variant)', () => {
    expect(html).toContain('<title>Durable</title>');
  });

  it('has no login form — Mode A mints the session, this page only instructs', () => {
    expect(html).not.toContain('<form');
    expect(html).not.toContain('id="username"');
    expect(html).not.toContain('id="password"');
  });

  it('explains the host mints the session and links back to basePath, with no inline script', () => {
    expect(html).toContain('<h1>Open this console from your application</h1>');
    expect(html).toContain('Your session is minted by the host app.');
    expect(html).toContain('<a class="button" href="/durable">Retry</a>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onclick');
  });

  it("shares renderLoginPage's dark zinc/emerald palette (same page() shell)", () => {
    expect(html).toContain('#09090b');
    expect(html).toContain('#18181b');
    expect(html).toContain('#34d399');
    expect(html).toContain('ui-monospace');
  });
});
