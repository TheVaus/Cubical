/**
 * Reuses previous-frame object references for unchanged list items, keyed
 * by identity. `<For>` in Solid reconciles by object reference — feeding it
 * a freshly-allocated object every render (even with identical field
 * values) tears down and remounts that row's DOM. List builders that
 * re-derive their output from scratch on every source-signal update
 * (file tree, backlinks, mentions, search results) run their result
 * through this first so unrelated rows keep their mounted DOM across a
 * refresh that changed nothing about them.
 */
export function stabilizeByKey<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
  equal: (a: T, b: T) => boolean,
): T[] {
  const prevByKey = new Map<string, T>();
  for (const item of prev) prevByKey.set(keyOf(item), item);
  return next.map((item) => {
    const prior = prevByKey.get(keyOf(item));
    return prior !== undefined && equal(prior, item) ? prior : item;
  });
}
