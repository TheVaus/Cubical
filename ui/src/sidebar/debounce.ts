/**
 * Trailing-edge debounce. Returns a callable that delays `fn` until
 * `ms` has elapsed since the last invocation; `.cancel()` drops any
 * pending call. Used by the search panel to throttle keystroke-driven
 * queries.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = ((...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  }) as Debounced<A>;
  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}
