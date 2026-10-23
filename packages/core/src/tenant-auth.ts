import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Layered tenant auth for the store-less cluster. On a tenant worker the `tenant` on a
 * {@link import('./interfaces').RunRequest} / {@link import('./interfaces').StartRunMessage} is only
 * a CLAIM: without a signed proof, any broker client can act as any tenant. This module is the
 * default defense in depth on top of prefix/network isolation: a symmetric HMAC token the tenant
 * worker presents IN the existing `tenant` wire field, which the operator's {@link TenantVerifier}
 * checks and DERIVES the real tenant from, never trusting the body.
 *
 * Wire-compatible with Agora (`@adonis-agora/durable`) byte for byte: the token is
 * `<claim>.<base64url(HMAC-SHA256(secret, claim))>`, where `claim` is the tenant name, optionally
 * followed by `.exp<epochMs>`. It fits the `tenant: string` field with NO envelope change, so an
 * operator that does not verify simply treats the whole string as the tenant name (and finds no
 * runs, a safe failure), while an operator configured with {@link hmacTenantVerifier} verifies the
 * signature and scopes to the embedded tenant. Agora and Aviary tokens are interchangeable.
 *
 * HMAC (shared secret) is the zero-infra default; a deployment that prefers asymmetric or issued
 * tokens supplies its own {@link TenantVerifier} instead.
 */

/** The identity a {@link TenantVerifier} derives from a tenant's signed claim. */
export interface VerifiedTenant {
  /** The tenant the token authenticates as. The responder trusts THIS, never the request body. */
  tenant: string;
  /**
   * Capabilities the token grants, if the issuer scopes them. Carried for custom verifiers and for
   * wire parity with Agora; the built-in responder does NOT enforce them yet. A verified tenant can
   * call every verb, scoped to its own namespace.
   */
  capabilities?: string[] | undefined;
}

/**
 * Verifies a tenant's signed claim on the **operator** side, returning the {@link VerifiedTenant} it
 * authenticates as, or `null` (or throwing) to reject a tampered/invalid/absent token. The signed
 * token travels in the wire `tenant` field, so the responder passes that value as both `token` and
 * the advisory `tenant`.
 */
export type TenantVerifier = (input: {
  /** The signed token presented on the request. */
  token?: string | undefined;
  /** The tenant the request *claims* to be. Advisory only: the verifier derives the real one. */
  tenant?: string | undefined;
}) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/**
 * Where the tenant side gets the token it presents: a static string, or a function called before
 * every request (so a short-lived token from {@link signTenantToken} with `ttlMs` can be re-minted
 * or fetched from a secret store without restarting the worker).
 */
export type TenantTokenSource = string | (() => string | Promise<string>);

/** Separator between the claim and its signature. `.` never appears in base64url, so the LAST `.`
 *  splits the two halves unambiguously, and a tenant name may itself contain dots. */
const TOKEN_SEP = '.';

/** The trailing expiry marker an expiring token's claim carries (see {@link signTenantToken}). */
const EXP_SUFFIX = /\.exp(\d+)$/;

/** The HMAC digest that authenticates `claim` under `secret`. */
function sign(claim: string, secret: string): string {
  return createHmac('sha256', secret).update(claim).digest('base64url');
}

/**
 * Mint the signed token a tenant worker presents:
 * `` `${tenant}.${base64url(HMAC-SHA256(secret, tenant))}` ``. The worker carries only the token
 * (never the secret); the operator verifies it with the SAME `secret` via {@link hmacTenantVerifier}.
 */
export function signTenantToken(
  tenant: string,
  secret: string,
  opts?: {
    /**
     * Optional lifetime: the claim gains a `.exp<epochMs>` suffix, signed together with the tenant,
     * and {@link hmacTenantVerifier} rejects the token once that instant passes. Without it the
     * token never expires. Expiring and non-expiring tokens verify side by side. Tenant names
     * ending in `.exp<digits>` are reserved by this scheme.
     */
    ttlMs?: number;
    /** Injectable clock for tests. */
    now?: number;
  },
): string {
  const claim =
    opts?.ttlMs !== undefined
      ? `${tenant}${TOKEN_SEP}exp${(opts.now ?? Date.now()) + opts.ttlMs}`
      : tenant;
  return `${claim}${TOKEN_SEP}${sign(claim, secret)}`;
}

/**
 * Build the operator-side {@link TenantVerifier} for {@link signTenantToken} tokens under `secret`.
 * It recomputes the HMAC over the embedded claim and compares it in constant time, so a tampered
 * tenant, a forged/absent signature, a token signed with another secret, or an expired token all
 * return `null`. The tenant is DERIVED from the token's own claim.
 *
 * A LIST of secrets makes rotation a two-step deploy: verify with `[next, current]` everywhere first,
 * then re-mint tenant tokens with `next` at leisure. `capabilities`, if given, is a static grant
 * stamped onto every {@link VerifiedTenant} this verifier authenticates (informational: the
 * responder does not enforce it yet, see {@link VerifiedTenant.capabilities}).
 */
export function hmacTenantVerifier(
  secret: string | string[],
  capabilities?: string[],
): TenantVerifier {
  const secrets = Array.isArray(secret) ? secret : [secret];
  return ({ token }): VerifiedTenant | null => {
    if (typeof token !== 'string' || token.length === 0) return null;
    const sep = token.lastIndexOf(TOKEN_SEP);
    if (sep <= 0 || sep === token.length - 1) return null; // no claim or no signature half
    const claim = token.slice(0, sep);
    const presented = token.slice(sep + 1);
    if (!secrets.some((s) => constantTimeEquals(presented, sign(claim, s)))) return null;
    // The expiry suffix is INSIDE the signature, so it can be neither stripped nor extended.
    const exp = EXP_SUFFIX.exec(claim);
    if (exp) {
      const expiresAt = Number(exp[1]);
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
      const tenant = claim.slice(0, claim.length - (exp[0]?.length ?? 0));
      if (tenant.length === 0) return null;
      return capabilities !== undefined ? { tenant, capabilities } : { tenant };
    }
    return capabilities !== undefined ? { tenant: claim, capabilities } : { tenant: claim };
  };
}

/**
 * Resolve the tenant a wire message is ALLOWED to act as. With a verifier, the wire `tenant` is the
 * signed token: it is verified and the real tenant derived from it (`null` on reject). Without one,
 * the wire value is trusted verbatim (prefix/network isolation only, today's behaviour).
 */
export async function resolveWireTenant(
  wireTenant: string,
  verifyTenant: TenantVerifier | undefined,
): Promise<string | null> {
  if (!verifyTenant) return wireTenant;
  const verified = await verifyTenant({ token: wireTenant, tenant: wireTenant });
  return verified ? verified.tenant : null;
}

/** Resolve a {@link TenantTokenSource} to the token string to put on the wire. */
export async function resolveTenantToken(source: TenantTokenSource): Promise<string> {
  return typeof source === 'function' ? source() : source;
}

/** Constant-time compare that never throws on a length mismatch. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
