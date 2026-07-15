/**
 * Compute the worker group a tenant's run dispatches to. Mirrors the transport's
 * default-is-bare rule (unset/empty/`'default'` ⇒ bare): a
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

/**
 * Sanitize a handler/workflow name for use as a BullMQ queue token: BullMQ forbids `:` in queue
 * names (it uses the colon internally as a key separator), so every `:` is replaced with `-`. `.`
 * is legal in a BullMQ queue name and is left as-is — step/workflow names commonly use it as a
 * namespacing separator (e.g. `payments.charge-card`).
 */
export function sanitizeQueueToken(name: string): string {
  return name.replace(/:/g, '-');
}
