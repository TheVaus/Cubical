const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelativeTime(
  mtimeSecs: number,
  nowMs: number = Date.now(),
): string {
  const deltaSecs = Math.floor(nowMs / 1000) - mtimeSecs;
  if (deltaSecs < MINUTE) return "just now";
  if (deltaSecs < HOUR) return `${Math.floor(deltaSecs / MINUTE)}m ago`;
  if (deltaSecs < DAY) return `${Math.floor(deltaSecs / HOUR)}h ago`;
  if (deltaSecs < WEEK) return `${Math.floor(deltaSecs / DAY)}d ago`;
  if (deltaSecs < MONTH) return `${Math.floor(deltaSecs / WEEK)}w ago`;
  if (deltaSecs < YEAR) return `${Math.floor(deltaSecs / MONTH)}mo ago`;
  return `${Math.floor(deltaSecs / YEAR)}y ago`;
}
