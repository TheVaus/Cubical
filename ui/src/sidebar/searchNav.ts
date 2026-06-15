/**
 * Roving-focus keyboard navigation for the grouped search-result list.
 *
 * The navigable units are the file groups (`buildFileGroups`): each group
 * header opens its file, so navigating per group — not per snippet card,
 * which all open the same file — is the meaningful granularity. The pure
 * index math lives here so `SearchPanel.tsx` (operator-smoke-only, Contract
 * E) holds no untested logic.
 */

/** Keys that move focus within the grouped search-result list. */
export type SearchNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

const NAV_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

/** True when `key` is one of the four list-navigation keys. */
export function isSearchNavKey(key: string): key is SearchNavKey {
  return NAV_KEYS.includes(key);
}

/**
 * Next focused group index for a list of `count` file groups. `current` is
 * the focused index, or -1 when nothing is focused yet. `ArrowDown`/`ArrowUp`
 * move one step and clamp at the ends; from nothing-focused they enter at the
 * first / last group respectively. `Home`/`End` jump to the ends. An empty
 * list always yields -1 (nothing focusable).
 */
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
