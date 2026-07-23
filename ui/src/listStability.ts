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
