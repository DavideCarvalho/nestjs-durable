// The "Authenticate tenants" guide's OIDC tenant-side example, kept compiling and tested
// (`tenant-auth-guide.spec.ts`). The guide imports from '@dudousxd/nestjs-durable'.
import type { TenantCredentialsContract } from '../index';

export interface ClientCredentialsOptions {
  /** The IdP's token endpoint (`token_endpoint` in its discovery document). */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** The control plane's resource identifier, sent as `resource` (RFC 8707). */
  resource: string;
  scope?: string;
  /** Fetch a new token this many seconds before the current one expires. Default 60. */
  refreshSkewSec?: number;
}

/**
 * Gets the tenant's access token with the OAuth `client_credentials` grant and keeps it fresh. Calls
 * made while a request to the IdP is in flight share it. When the IdP fails, the current token is
 * kept while it is still valid and the IdP is not asked again for 5 seconds.
 */
export class ClientCredentials implements TenantCredentialsContract {
  private current: { token: string; refreshAt: number; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private retryAt = 0;

  constructor(private readonly options: ClientCredentialsOptions) {}

  async token(): Promise<string> {
    const now = Date.now();
    const current = this.current;
    if (current && now < current.refreshAt) return current.token;
    const stillValid = current && now < current.expiresAt ? current.token : undefined;
    if (stillValid && now < this.retryAt) return stillValid;

    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    try {
      return await this.inflight;
    } catch (error) {
      this.retryAt = Date.now() + 5_000;
      if (stillValid) return stillValid;
      throw error;
    }
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, resource, scope } = this.options;
    const body = new URLSearchParams({ grant_type: 'client_credentials', resource });
    if (scope) body.set('scope', scope);
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString('base64');
    const response = await fetch(this.options.tokenEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    // Never put the response body in the error: it is not ours to log.
    if (!response.ok) throw new Error(`token endpoint answered HTTP ${response.status}`);
    const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string')
      throw new Error('token response has no access_token');

    const lifetimeMs = (typeof json.expires_in === 'number' ? json.expires_in : 300) * 1000;
    const skewMs = (this.options.refreshSkewSec ?? 60) * 1000;
    const now = Date.now();
    this.current = {
      token: json.access_token,
      expiresAt: now + lifetimeMs,
      // A token shorter-lived than the skew is refreshed at half its life instead.
      refreshAt: now + (skewMs < lifetimeMs ? lifetimeMs - skewMs : lifetimeMs / 2),
    };
    this.retryAt = 0;
    return json.access_token;
  }
}
