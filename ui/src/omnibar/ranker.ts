/** A heterogeneous Omni-Bar target: a note or a tag. */
export type OmniItem =
  | { kind: "note"; title: string; path: string }
  | { kind: "tag"; tag: string };

/** The text a query is matched against for an item. */
export function matchText(item: OmniItem): string {
  return item.kind === "note" ? item.title : item.tag;
}

/**
 * Greedy, case-insensitive subsequence match of `query` against `text`,
 * by code point (so multi-byte chars index correctly). Returns the
 * matched code-point indices, or `null` if `query` is not a subsequence.
 * An empty query matches with an empty index list.
 */
export function fuzzyMatch(query: string, text: string): number[] | null {
  const q = [...query.toLowerCase()];
  const t = [...text];
  const tl = [...text.toLowerCase()];
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (tl[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  return qi === q.length ? indices : null;
}
