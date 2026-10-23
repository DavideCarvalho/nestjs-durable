import { describe, expect, it } from 'vitest';
import { hmacTenantVerifier, resolveWireTenant, signTenantToken } from './tenant-auth';

const SECRET = 'super-secret-signing-key';

// Ported from Agora's `tenant-auth.spec.ts`; the scheme is shared byte for byte.
describe('tenant-auth (HMAC signed tenant token)', () => {
  it('verifies a token minted with the same secret and DERIVES the tenant from it', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET);
    // The token travels in the request `tenant` field, so the responder passes it as `token`.
    expect(await verify({ token, tenant: token })).toEqual({ tenant: 'acme' });
  });

  it('derives the tenant from the TOKEN, ignoring any advisory `tenant` in the body', async () => {
    const token = signTenantToken('acme', SECRET);
    expect(await hmacTenantVerifier(SECRET)({ token, tenant: 'evil' })).toEqual({ tenant: 'acme' });
  });

  it('stamps static capabilities onto the verified tenant when configured', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET, ['saga', 'signals']);
    expect(await verify({ token })).toEqual({ tenant: 'acme', capabilities: ['saga', 'signals'] });
  });

  it('REJECTS a token whose tenant claim was tampered (signature no longer matches)', async () => {
    const token = signTenantToken('acme', SECRET);
    const sig = token.slice(token.lastIndexOf('.') + 1);
    expect(await hmacTenantVerifier(SECRET)({ token: `evil.${sig}` })).toBeNull();
  });

  it('REJECTS a token whose signature was tampered', async () => {
    const token = signTenantToken('acme', SECRET);
    expect(await hmacTenantVerifier(SECRET)({ token: `${token}x` })).toBeNull();
  });

  it('REJECTS a token signed with a different secret', async () => {
    const token = signTenantToken('acme', 'a-different-secret');
    expect(await hmacTenantVerifier(SECRET)({ token })).toBeNull();
  });

  it('REJECTS a malformed / empty / signature-less token', async () => {
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token: '' })).toBeNull();
    expect(await verify({ token: undefined })).toBeNull();
    expect(await verify({ token: 'no-separator' })).toBeNull();
    expect(await verify({ token: 'acme.' })).toBeNull();
    expect(await verify({ token: '.sig' })).toBeNull();
  });

  it('preserves a tenant name containing dots (splits on the LAST separator)', async () => {
    const token = signTenantToken('team.acme.eu', SECRET);
    expect(await hmacTenantVerifier(SECRET)({ token })).toEqual({ tenant: 'team.acme.eu' });
  });

  it('accepts any secret of a rotation list', async () => {
    const verify = hmacTenantVerifier(['next', SECRET]);
    expect(await verify({ token: signTenantToken('acme', SECRET) })).toEqual({ tenant: 'acme' });
    expect(await verify({ token: signTenantToken('acme', 'next') })).toEqual({ tenant: 'acme' });
    expect(await verify({ token: signTenantToken('acme', 'other') })).toBeNull();
  });

  it('honours an expiring token until its instant passes, and the suffix cannot be stripped', async () => {
    const verify = hmacTenantVerifier(SECRET);
    const live = signTenantToken('acme', SECRET, { ttlMs: 60_000 });
    expect(await verify({ token: live })).toEqual({ tenant: 'acme' });
    const expired = signTenantToken('acme', SECRET, { ttlMs: 1_000, now: Date.now() - 10_000 });
    expect(await verify({ token: expired })).toBeNull();
    // Dropping `.exp<ms>` from the claim breaks the signature.
    const sig = expired.slice(expired.lastIndexOf('.') + 1);
    expect(await verify({ token: `acme.${sig}` })).toBeNull();
  });

  it('cross-compat: verifies tokens minted by Agora (`@adonis-agora/durable` signTenantToken)', async () => {
    // Vectors produced by running Agora's own `packages/adonis/src/run-gateway/tenant-auth.ts`:
    //   signTenantToken('acme-corp', 'agora-shared-secret')
    //   signTenantToken('acme.corp', 'agora-shared-secret', { ttlMs: 1000, now: 4102444800000 - 1000 })
    const agoraToken = 'acme-corp.b5t5mXfrVHtRsoMLeqTnAadE7EcZZMK5vxtd4JkibSg';
    const agoraExpiring = 'acme.corp.exp4102444800000.j4sLDXzPxzqA46-2rQ-VzHQNlLNGpDf2eD6NJ9RJc9M';
    const verify = hmacTenantVerifier('agora-shared-secret');
    expect(await verify({ token: agoraToken })).toEqual({ tenant: 'acme-corp' });
    expect(await verify({ token: agoraExpiring })).toEqual({ tenant: 'acme.corp' });
    // And Aviary mints the identical bytes, so an Aviary tenant is accepted by an Agora operator.
    expect(signTenantToken('acme-corp', 'agora-shared-secret')).toBe(agoraToken);
    expect(
      signTenantToken('acme.corp', 'agora-shared-secret', {
        ttlMs: 1000,
        now: 4102444800000 - 1000,
      }),
    ).toBe(agoraExpiring);
  });

  it('resolveWireTenant trusts the wire value verbatim without a verifier', async () => {
    expect(await resolveWireTenant('acme', undefined)).toBe('acme');
    expect(await resolveWireTenant('acme', hmacTenantVerifier(SECRET))).toBeNull();
  });
});
