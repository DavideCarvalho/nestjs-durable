import { tenantLabels } from './tenancy-reader.js';

/** A run row that may carry a customer tenant (`tenantId`, `tenantKind`). */
interface TenantRow {
  tenantId?: string | null | undefined;
  tenantKind?: string | null | undefined;
}

/**
 * `rows`, each with a `tenantLabel` when it has a tenant: the display name the app's context gives it
 * (`tenancy.label`), else its slug, else its id. One label lookup for the whole page; a run with no
 * tenant is returned as is. Never throws: a failing resolver falls back to the ids.
 */
export async function withTenantLabels<R extends TenantRow>(
  rows: R[],
): Promise<Array<R & { tenantLabel?: string }>> {
  const levels = new Map<string, { id: string; kind: string }>();
  for (const row of rows) {
    if (row.tenantId != null && !levels.has(row.tenantId)) {
      levels.set(row.tenantId, { id: row.tenantId, kind: row.tenantKind ?? 'unknown' });
    }
  }
  if (levels.size === 0) return rows;
  let labels: Record<string, string>;
  try {
    labels = await tenantLabels([...levels.values()]);
  } catch {
    labels = {};
  }
  return rows.map((row) =>
    row.tenantId != null ? { ...row, tenantLabel: labels[row.tenantId] ?? row.tenantId } : row,
  );
}
