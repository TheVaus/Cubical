export type OmniItem =
  | { kind: "note"; title: string; path: string }
  | { kind: "tag"; tag: string }
  | { kind: "command"; id: string; title: string };

export function matchText(item: OmniItem): string {
  if (item.kind === "note") return item.title;
  if (item.kind === "tag") return item.tag;
  return item.title;
}

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

export function approxSubstringDistance(query: string, text: string): number {
  const q = [...query];
  const t = [...text];
  const m = q.length;
  if (m === 0) return 0;
  let prev = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(t.length + 1);
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        prev[j - 1]! + cost,
        prev[j]! + 1,
        cur[j - 1]! + 1,
      );
    }
    prev = cur;
  }
  return Math.min(...prev);
}

function maxEdits(queryLen: number): number {
  if (queryLen <= 2) return 0;
  if (queryLen <= 5) return 1;
  return 2;
}

const SUBSEQUENCE_TIER = 1000;

export interface RankedItem {
  item: OmniItem;
  score: number;
  matchedIndices: number[];
}

const BOUNDARY = /[\s/\-_.]/;

export function scoreMatch(text: string, indices: number[]): number {
  if (indices.length === 0) return 0;
  const t = [...text];
  const tl = text.toLowerCase();
  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    if (k > 0 && indices[k - 1] === i - 1) score += 8;
    if (i === 0 || BOUNDARY.test(t[i - 1]!)) score += 6;
    score += Math.max(0, 4 - i * 0.1);
  }
  const matched = indices
    .map((i) => t[i])
    .join("")
    .toLowerCase();
  const contiguous = indices.every(
    (v, k) => k === 0 || v === indices[k - 1]! + 1,
  );
  if (tl === matched) score += 40;
  else if (indices[0] === 0 && contiguous) score += 20;
  score -= t.length * 0.05;
  return score;
}

function kindRank(item: OmniItem): number {
  return item.kind === "note" ? 0 : item.kind === "tag" ? 1 : 2;
}

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
    const ar = kindRank(a.item);
    const br = kindRank(b.item);
    if (ar !== br) return ar - br;
    return matchText(a.item).localeCompare(matchText(b.item));
  });
  return ranked.slice(0, limit);
}
