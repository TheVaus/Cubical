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

/** One ranked result with highlight positions. */
export interface RankedItem {
  item: OmniItem;
  score: number;
  /** Code-point indices into `matchText(item)` that matched. */
  matchedIndices: number[];
}

/** Chars that begin a "word" — a match right after one scores higher. */
const BOUNDARY = /[\s/\-_.]/;

/** Score a set of matched indices in `text`. Higher is better. */
export function scoreMatch(text: string, indices: number[]): number {
  if (indices.length === 0) return 0;
  const t = [...text];
  const tl = text.toLowerCase();
  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    if (k > 0 && indices[k - 1] === i - 1) score += 8; // contiguous run
    if (i === 0 || BOUNDARY.test(t[i - 1]!)) score += 6; // word boundary
    score += Math.max(0, 4 - i * 0.1); // earlier is better
  }
  const matched = indices
    .map((i) => t[i])
    .join("")
    .toLowerCase();
  const contiguous = indices.every(
    (v, k) => k === 0 || v === indices[k - 1]! + 1,
  );
  if (tl === matched) score += 40; // exact full match
  else if (indices[0] === 0 && contiguous) score += 20; // exact prefix
  score -= t.length * 0.05; // mild shorter-is-better
  return score;
}

/**
 * Rank `items` against `query` (non-empty), best first. Non-matches are
 * dropped. Deterministic ties: higher score → shorter target → note
 * before tag → alphabetical. Capped at `limit`.
 */
export function rankItems(
  query: string,
  items: OmniItem[],
  limit: number,
): RankedItem[] {
  const q = query.trim();
  if (q === "") return [];
  const ranked: RankedItem[] = [];
  for (const item of items) {
    const text = matchText(item);
    const indices = fuzzyMatch(q, text);
    if (indices === null) continue;
    ranked.push({
      item,
      score: scoreMatch(text, indices),
      matchedIndices: indices,
    });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const al = matchText(a.item).length;
    const bl = matchText(b.item).length;
    if (al !== bl) return al - bl;
    if (a.item.kind !== b.item.kind) return a.item.kind === "note" ? -1 : 1;
    return matchText(a.item).localeCompare(matchText(b.item));
  });
  return ranked.slice(0, limit);
}
