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

/**
 * Minimum edit distance (insert / delete / substitute) to align `query`
 * with the best-matching *substring* of `text` — Sellers' k-approximate
 * substring search. `0` ⇒ `query` is an exact substring. This is what
 * makes the Omni-Bar genuinely typo-tolerant (a *substituted* letter,
 * not just a skipped one): `approxSubstringDistance("ricj", "…_rich")`
 * is `1`. Both args should already be lowercased by the caller. O(query
 * × text).
 */
export function approxSubstringDistance(query: string, text: string): number {
  const q = [...query];
  const t = [...text];
  const m = q.length;
  if (m === 0) return 0;
  // Row 0 = empty query prefix: a match may begin anywhere → all zeros.
  let prev = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(t.length + 1);
    cur[0] = i; // i query chars vs an empty text prefix → i deletions
    for (let j = 1; j <= t.length; j++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        prev[j - 1]! + cost, // substitute / match
        prev[j]! + 1, // delete a query char
        cur[j - 1]! + 1, // skip a text char
      );
    }
    prev = cur;
  }
  return Math.min(...prev); // best alignment ending anywhere in `text`
}

/** Edit-distance budget for the fuzzy fallback, scaled to query length. */
function maxEdits(queryLen: number): number {
  if (queryLen <= 2) return 0; // too short to disambiguate a typo
  if (queryLen <= 5) return 1;
  return 2;
}

/** Subsequence matches always outrank fuzzy (typo) matches. */
const SUBSEQUENCE_TIER = 1000;

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
  const budget = maxEdits([...q].length);
  const ql = q.toLowerCase();
  const ranked: RankedItem[] = [];
  for (const item of items) {
    const text = matchText(item);
    const indices = fuzzyMatch(q, text);
    if (indices !== null) {
      // Strong match: the query is a subsequence. Ranks above any typo
      // match via the tier offset; keep the highlight indices.
      ranked.push({
        item,
        score: SUBSEQUENCE_TIER + scoreMatch(text, indices),
        matchedIndices: indices,
      });
      continue;
    }
    if (budget > 0) {
      const dist = approxSubstringDistance(ql, text.toLowerCase());
      if (dist <= budget) {
        // Typo match: the query isn't a subsequence but aligns within
        // the edit budget. Ranks below every subsequence match; fewer
        // edits + shorter target rank higher. No highlight (the typed
        // text doesn't appear verbatim).
        ranked.push({
          item,
          score: -dist * 100 - [...text].length * 0.05,
          matchedIndices: [],
        });
      }
    }
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
