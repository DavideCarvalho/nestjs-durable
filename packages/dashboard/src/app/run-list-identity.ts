/**
 * The two identities the runs list is built on: which RUN a rendered row is, and which RESULT SET
 * the list is currently showing.
 *
 * Both live here rather than inline in the component because getting either wrong is invisible to a
 * type checker and only shows up as a garbled pane in front of an operator.
 */

/**
 * The virtualiser's key for the row at `index`.
 *
 * React reconciles these rows by `run.id`, so the virtualiser has to key its size and element caches
 * by the same thing. Under the virtualiser's default key — the array index — a change that moves a
 * surviving run to a different index does not remount its node, so its measurement is never
 * re-attributed: each index keeps the height of whoever sat there before, `getTotalSize()` and every
 * row offset are computed from those stale heights, and the list renders with overlapping rows and
 * gaps that only a remount repairs.
 *
 * Falling back to the index covers a row asked about beyond the loaded page: an estimate under a key
 * no real run can collide with.
 */
export function runRowKey(runs: readonly { id: string }[], index: number): string | number {
  return runs[index]?.id ?? index;
}

/** Everything that decides WHICH runs the server returns. Not how many pages of them are loaded. */
export interface RunsFilterIdentity {
  /** The lit status chip, or `all`. */
  status: string;
  tag: string;
  /** The attribute predicates, already joined — see `attrKey`. */
  attrs: string;
  namespace: string;
  /** The origin facet, already flattened — see `originFilterKey`. */
  origin: string;
}

/**
 * A single string identifying the result set the filters select.
 *
 * The list is keyed on it, so re-scoping the view gives the operator a fresh scroll container
 * starting at the top instead of an arbitrary offset into a set they have never seen; and the loaded
 * page count is stored against it, so the reset happens in the same render that changes the query
 * key rather than a render later — a render later means one wasted request at the old count.
 *
 * JSON-encoded rather than concatenated, so no combination of filter values can spell another.
 */
export function runsFilterKey(f: RunsFilterIdentity): string {
  return JSON.stringify([f.status, f.tag, f.attrs, f.namespace, f.origin]);
}
