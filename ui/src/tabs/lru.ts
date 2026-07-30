export const DEFAULT_LIVE_TAB_LIMIT = 8;

export function clampLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_LIVE_TAB_LIMIT;
  return Math.max(1, Math.floor(raw));
}

export function touch(mru: string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

export function liveIds(
  mru: string[],
  activeId: string | null,
  limit: number,
): string[] {
  const cap = clampLimit(limit);
  const ordered = activeId === null ? mru : touch(mru, activeId);
  return ordered.slice(0, cap);
}

export function liveFileIds(
  mru: string[],
  activeId: string | null,
  limit: number,
  isFile: (id: string) => boolean,
): string[] {
  const filtered = mru.filter(isFile);
  const active = activeId !== null && isFile(activeId) ? activeId : null;
  return liveIds(filtered, active, limit);
}
