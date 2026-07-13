import { describe, expect, it } from 'vitest';
import { renderLoginPage } from './login-page';

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
