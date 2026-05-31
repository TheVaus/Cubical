export interface PendingRewritesDisplay {
  /** Footer label, e.g. "2 pending changes". */
  label: string;
}

/**
 * Footer display for the L3 Session J pending-rewrites cache, or
 * `null` when the queue is empty (so the caller renders nothing).
 * Mirrors `formatBrokenBlockRefs` in `statusbar/brokenRefs.ts`.
 *
 * See `docs/layer-3-spec.md` §9.16.
 */
export function formatPendingRewrites(
  count: number,
): PendingRewritesDisplay | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "pending change" : "pending changes";
  return { label: `${count} ${noun}` };
}
