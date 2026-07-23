export type SearchNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

const NAV_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

export function isSearchNavKey(key: string): key is SearchNavKey {
  return NAV_KEYS.includes(key);
}

export function nextSearchNavIndex(
  key: SearchNavKey,
  current: number,
  count: number,
): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case "ArrowUp":
      return current < 0 ? count - 1 : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}
