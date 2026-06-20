/**
 * Given an ordered list of segment visibilities, decide whether each visible
 * segment needs a leading `·` separator — true only when some earlier segment
 * is also visible. Hidden segments always get `false`. Lets the footer render
 * separators from the live visible set instead of hardcoded leading `·`s that
 * dangle when a preceding segment is toggled off.
 */
export function leadingSeparators(visible: boolean[]): boolean[] {
  let anyBefore = false;
  return visible.map((v) => {
    const sep = v && anyBefore;
    if (v) anyBefore = true;
    return sep;
  });
}
