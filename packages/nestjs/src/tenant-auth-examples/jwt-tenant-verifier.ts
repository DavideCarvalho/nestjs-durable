// The "Authenticate tenants" guide's JWT example, kept compiling and tested
// (`tenant-auth-guide.spec.ts`). The guide imports from '@dudousxd/nestjs-durable'.
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JsonWebTokenError, JwtService } from '@nestjs/jwt';
import type { TenantVerifierContract, TenantVerifierInput, VerifiedTenant } from '../index';

/** The claims a tenant token carries. */
export interface TenantTokenClaims {
  /** The partition the tenant process acts as. */
  partition: string;
  /** What the tenant may do. Optional. */
  capabilities?: string[];
  exp?: number;
}

/** Must match the `audience` the tokens are signed with. */
export const TENANT_TOKEN_AUDIENCE = 'durable-tenant';

/**
 * Verifies tenant tokens signed by this app's own `JwtModule`. The control plane sees every message a
 * tenant sends, so each result, accepted or rejected, is reused for `CACHE_TTL_MS` (never past the
 * token's own expiry) instead of verifying the signature every time.
 */
@Injectable()
export class JwtTenantVerifier implements TenantVerifierContract {
  private static readonly CACHE_TTL_MS = 30_000;
  private static readonly MAX_ENTRIES = 10_000;
  private readonly cache = new Map<string, { result: VerifiedTenant | null; until: number }>();

  constructor(private readonly jwt: JwtService) {}

  async verify({ token }: TenantVerifierInput): Promise<VerifiedTenant | null> {
    if (!token) return null;
    // Keyed by a hash, so the cache never holds a usable token.
    const key = createHash('sha256').update(token).digest('base64url');
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.result;

    let claims: TenantTokenClaims | undefined;
    try {
      claims = await this.jwt.verifyAsync<TenantTokenClaims>(token, {
        audience: TENANT_TOKEN_AUDIENCE,
      });
    } catch (error) {
      // A bad, expired or foreign token is a rejection. Anything else is an error the tenant sees.
      if (!(error instanceof JsonWebTokenError)) throw error;
    }
    const result =
      claims && typeof claims.partition === 'string' && claims.partition !== ''
        ? {
            tenant: claims.partition,
            capabilities: Array.isArray(claims.capabilities) ? claims.capabilities : undefined,
          }
        : null;

    let until = Date.now() + JwtTenantVerifier.CACHE_TTL_MS;
    if (claims?.exp) until = Math.min(until, claims.exp * 1000);
    this.cache.delete(key);
    this.cache.set(key, { result, until });
    if (this.cache.size > JwtTenantVerifier.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return result;
  }
}

/** The default export is what the lazy form `() => import('./jwt-tenant-verifier.js')` loads. */
export default JwtTenantVerifier;
