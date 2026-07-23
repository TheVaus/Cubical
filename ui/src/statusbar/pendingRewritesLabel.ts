export interface PendingRewritesDisplay {
  label: string;
}

export function formatPendingRewrites(
  count: number,
): PendingRewritesDisplay | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "pending change" : "pending changes";
  return { label: `${count} ${noun}` };
}
