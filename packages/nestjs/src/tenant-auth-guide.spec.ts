// The "Authenticate tenants" guide's examples (`tenant-auth-examples/`), run for real: a JwtService
// from @nestjs/jwt, and an OIDC provider served by a local HTTP server (JWKS + token endpoint).
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Heartbeat,
  InMemoryStateStore,
  type RunReply,
  type RunRequest,
  type StepResult,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { hmacTenantVerifier, signTenantToken } from './index';
import { ProxyRunGateway, RunGatewayError } from './proxy-run-gateway';
import { RunRequestResponder } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';
import { ClientCredentials } from './tenant-auth-examples/client-credentials';
import {
  JwtTenantVerifier,
  TENANT_TOKEN_AUDIENCE,
} from './tenant-auth-examples/jwt-tenant-verifier';
import { OidcTenantVerifier } from './tenant-auth-examples/oidc-tenant-verifier';
import { resolveTenantTokenSource, resolveTenantVerifier } from './tenant-contracts';

/** An operator transport whose run-request handler the test drives. */
class OperatorTransport implements Transport {
  request?: (msg: RunRequest) => Promise<void>;
  replies: RunReply[] = [];
  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.request = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    this.replies.push(reply);
  }
}

async function seededStore(): Promise<InMemoryStateStore> {
  const store = new InMemoryStateStore();
  for (const [id, namespace] of [
    ['mine', 'acme'],
    ['theirs', 'beta'],
  ] as const) {
    await store.createRun({
      id,
      workflow: 'wf',
      workflowVersion: '1',
      status: 'completed',
      input: null,
      namespace,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return store;
}

/** Boots a control plane with `verifyTenant` and returns a function that lists runs as `token`. */
async function controlPlane(verifyTenant: DurableModuleOptions['verifyTenant']) {
  const transport = new OperatorTransport();
  const moduleRef = await Test.createTestingModule({
    imports: [
      JwtModule.register({ global: true, secret: 'jwt-signing-secret' }),
      DurableModule.forRoot({
        topology: 'control-plane',
        store: await seededStore(),
        transport,
        timerPollMs: 0,
        ...(verifyTenant !== undefined ? { verifyTenant } : {}),
      }),
    ],
  }).compile();
  await moduleRef.init();
  const listAs = async (token: string) => {
    const requestId = String(transport.replies.length);
    await transport.request?.({ requestId, tenant: token, body: { kind: 'listRuns', query: {} } });
    const result = transport.replies.at(-1)?.result;
    return result?.ok ? (result.data as { id: string }[]).map((r) => r.id) : result?.error.code;
  };
  return { moduleRef, listAs };
}

describe('guide: your own JWT (@nestjs/jwt)', () => {
  it('the class form, built through DI with the app JwtService', async () => {
    const { moduleRef, listAs } = await controlPlane(JwtTenantVerifier);
    const jwt = moduleRef.get(JwtService);
    const token = await jwt.signAsync(
      { partition: 'acme', capabilities: ['gpu'] },
      { audience: TENANT_TOKEN_AUDIENCE, expiresIn: '1h' },
    );
    expect(await listAs(token)).toEqual(['mine']);

    const wrongAudience = await jwt.signAsync({ partition: 'beta' }, { audience: 'someone-else' });
    const expired = await jwt.signAsync(
      { partition: 'beta' },
      { audience: TENANT_TOKEN_AUDIENCE, expiresIn: -10 },
    );
    const otherKey = await new JwtService({ secret: 'not-ours' }).signAsync(
      { partition: 'beta' },
      { audience: TENANT_TOKEN_AUDIENCE },
    );
    for (const bad of [wrongAudience, expired, otherKey, 'not-a-jwt']) {
      expect(await listAs(bad)).toBe('unauthorized');
    }
    await moduleRef.close();
  });

  it('caches each result, so a token is verified once per TTL', async () => {
    const jwt = new JwtService({ secret: 's' });
    const verifier = new JwtTenantVerifier(jwt);
    const spy = vi.spyOn(jwt, 'verifyAsync');
    const token = await jwt.signAsync({ partition: 'acme' }, { audience: TENANT_TOKEN_AUDIENCE });
    expect(await verifier.verify({ token })).toEqual({ tenant: 'acme', capabilities: undefined });
    expect(await verifier.verify({ token })).toEqual({ tenant: 'acme', capabilities: undefined });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await verifier.verify({})).toBeNull();
  });

  it('the lazy-import form loads the module once', async () => {
    const load = vi.fn(() => import('./tenant-auth-examples/jwt-tenant-verifier'));
    const { moduleRef, listAs } = await controlPlane(load);
    const token = await moduleRef
      .get(JwtService)
      .signAsync({ partition: 'acme' }, { audience: TENANT_TOKEN_AUDIENCE });
    expect(await listAs(token)).toEqual(['mine']);
    expect(await listAs(token)).toEqual(['mine']);
    expect(load).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});

describe('guide: any OIDC provider (jose + client_credentials)', () => {
  const issuer = 'https://idp.test';
  const audience = 'urn:aviary:durable';
  let server: Server;
  let base: string;
  let tokenRequests = 0;
  let expiresIn = 3600;
  let failTokenEndpoint = false;
  let sign: (claims: Record<string, unknown>, opts?: { iss?: string }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    sign = (claims, opts) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(opts?.iss ?? issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    server = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url === '/jwks-broken') {
        res.setHeader('content-type', 'application/json');
        res.end('<html>maintenance</html>');
        return;
      }
      if (req.url === '/jwks-malformed') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: 'nope' }));
        return;
      }
      if (req.url === '/token' && req.method === 'POST') {
        tokenRequests++;
        const basic = Buffer.from('acme-client:acme-secret').toString('base64');
        if (failTokenEndpoint || req.headers.authorization !== `Basic ${basic}`) {
          res.statusCode = failTokenEndpoint ? 503 : 401;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          const form = new URLSearchParams(body);
          if (
            form.get('grant_type') !== 'client_credentials' ||
            form.get('resource') !== audience
          ) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const accessToken = await sign({ partition: 'acme', capabilities: ['gpu'] });
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: expiresIn,
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const credentials = () =>
    new ClientCredentials({
      tokenEndpoint: `${base}/token`,
      clientId: 'acme-client',
      clientSecret: 'acme-secret',
      resource: audience,
    });
  const verifier = () => new OidcTenantVerifier({ issuer, audience, jwksUri: `${base}/jwks` });

  it('a tenant proxy with ClientCredentials round-trips through a control plane with OidcTenantVerifier', async () => {
    tokenRequests = 0;
    expiresIn = 3600;
    const store = await seededStore();
    const operator = new StoreRunGateway(store, new WorkflowEngine({ store }));
    let onRequest: ((msg: RunRequest) => Promise<void>) | undefined;
    let onReply: ((reply: RunReply) => void) | undefined;
    new RunRequestResponder(
      {
        onRunRequest: (h) => {
          onRequest = h;
        },
        publishRunReply: async (r) => onReply?.(r),
      },
      operator,
      { verifyTenant: resolveTenantVerifier(verifier()) },
    ).start();
    const wire = {
      dispatchRunRequest: async (msg: RunRequest) => onRequest?.(msg),
      onRunReply: (h: (reply: RunReply) => void) => {
        onReply = h;
      },
    } as unknown as Transport;

    const tenant = new ProxyRunGateway(
      wire,
      'acme',
      2000,
      undefined,
      resolveTenantTokenSource(credentials()),
    );
    expect((await tenant.listRuns({})).map((r) => r.id)).toEqual(['mine']);
    expect((await tenant.listRuns({})).map((r) => r.id)).toEqual(['mine']);
    expect(tokenRequests).toBe(1); // cached until refresh time

    const forged = new ProxyRunGateway(wire, 'beta', 2000, undefined, 'not-a-jwt');
    const rejected = await forged.listRuns({}).catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(RunGatewayError);
    expect(rejected).toMatchObject({ code: 'unauthorized' });
  });

  it('verifies iss, aud and the partition and capabilities claims', async () => {
    const verify = verifier();
    expect(
      await verify.verify({ token: await sign({ partition: 'acme', capabilities: ['gpu'] }) }),
    ).toEqual({ tenant: 'acme', capabilities: ['gpu'] });
    expect(
      await verify.verify({ token: await sign({ partition: 'acme' }, { iss: 'evil' }) }),
    ).toBeNull();
    expect(await verify.verify({ token: await sign({ sub: 'no-partition' }) })).toBeNull();
    expect(await verify.verify({})).toBeNull();
  });

  it('a down IdP throws instead of rejecting the token', async () => {
    const token = await sign({ partition: 'acme' });
    // Nothing listens there: a network error.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = new OidcTenantVerifier({
      issuer,
      audience,
      jwksUri: `http://127.0.0.1:${closedPort}/jwks`,
    });
    await expect(offline.verify({ token })).rejects.toThrow();
    // The JWKS endpoint answers, but with an error page or a body that is not a key set.
    for (const path of ['/missing', '/jwks-broken', '/jwks-malformed']) {
      const verify = new OidcTenantVerifier({ issuer, audience, jwksUri: `${base}${path}` });
      await expect(verify.verify({ token })).rejects.toThrow();
    }
    // A reachable IdP still rejects a bad token with null.
    expect(await verifier().verify({ token: 'not-a-jwt' })).toBeNull();
  });

  it('shares one token request between concurrent calls, and refreshes before expiry', async () => {
    tokenRequests = 0;
    expiresIn = 120; // refreshed 60s before expiry, so at 60s
    const source = credentials();
    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokenRequests).toBe(1);

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(now + 59_000);
    await source.token();
    expect(tokenRequests).toBe(1);
    clock.mockReturnValue(now + 61_000);
    await source.token();
    expect(tokenRequests).toBe(2);

    // The IdP fails: the still-valid token is kept, and the IdP is not asked again for 5s.
    failTokenEndpoint = true;
    clock.mockReturnValue(now + 61_000 + 60_000);
    expect(typeof (await source.token())).toBe('string');
    expect(tokenRequests).toBe(3);
    await source.token();
    expect(tokenRequests).toBe(3);
    failTokenEndpoint = false;
    clock.mockRestore();
  });
});

describe('guide: a shared secret (HMAC)', () => {
  it('the existing helpers work as the function form', async () => {
    const { moduleRef, listAs } = await controlPlane(hmacTenantVerifier(['next', 'current']));
    expect(await listAs(signTenantToken('acme', 'current', { ttlMs: 60_000 }))).toEqual(['mine']);
    expect(await listAs(signTenantToken('acme', 'retired'))).toBe('unauthorized');
    await moduleRef.close();
  });
});
