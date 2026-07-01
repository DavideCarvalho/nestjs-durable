/**
 * Compute the worker group a tenant's run dispatches to. Mirrors the transport's
 * default-is-bare rule (see {@link TransportPool.useNamespace}'s `'default'` no-op): a
 * `tenant` of `undefined`, `''`, or `'default'` is the bare `baseGroup`, so a single-tenant
 * deployment (or the `'default'` tenant of a multi-tenant one) stays byte-identical to today.
 * Any other tenant suffixes the group as `<baseGroup>@<tenant>`, so an operator control plane
 * (namespace: undefined) can route each tenant's run to its own worker pool.
 */
export function tenantGroup(baseGroup: string, tenant: string | undefined): string {
  return tenant !== undefined && tenant !== '' && tenant !== 'default'
    ? `${baseGroup}@${tenant}`
    : baseGroup;
}
