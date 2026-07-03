import type { SearchHit } from "../api/ipc";
import { stabilizeByKey } from "../listStability";
import { parseHighlights, type HighlightSegment } from "./snippet";

/**
 * Shape search results for the grouped panel (Obsidian-core-search style).
 *
 * Each `SearchHit` is already one file; this turns it into a collapsible
 * file group whose match-count badge is its number of snippet cards. The
 * backend returns at most one snippet per matched field, so a file shows
 * 1–N cards ordered most-contextful first. (True per-occurrence cards —
 * the same field hit several times — would need a backend fragment change
 * and is deferred to the L4-A search revisit.)
 */

/** Card display order within a file group; mirrors `snippet.ts` priority. */
const CARD_ORDER = ["body", "headings", "code", "frontmatter", "title"];

/** One snippet card: a matched field's highlighted text, ready to render. */
export interface ResultCard {
  /** `"body" | "headings" | "code" | "frontmatter" | "title"` (or other). */
  field: string;
  /** Highlight segments (plain text + `<mark>` flag), never innerHTML. */
  segments: HighlightSegment[];
}

/** One file's worth of results: a header + its snippet cards. */
export interface FileGroup {
  /** Vault-relative path; stable key + navigation target. */
  path: string;
  /** Display title shown in the group header. */
  title: string;
  /** Unix-seconds mtime for the relative-recency label. */
  mtime_secs: number;
  /** Snippet cards, ordered by `CARD_ORDER` then backend order. */
  cards: ResultCard[];
}

/** Rank a field by `CARD_ORDER`; unknown fields sort after known ones. */
function order(field: string): number {
  const i = CARD_ORDER.indexOf(field);
  return i === -1 ? CARD_ORDER.length : i;
}

/**
 * Map relevance-ordered hits into file groups. Hit order is preserved
 * (the backend already ranked them); only the cards *within* each group
 * are reordered. Cards whose snippet yields no renderable text are
 * dropped — a group with no cards can still appear (title-only match with
 * an empty snippet is rare but harmless).
 */
export function buildFileGroups(hits: SearchHit[]): FileGroup[] {
  return hits.map((h) => {
    const cards = h.matched_fields
      .map((m) => ({ field: m.field, segments: parseHighlights(m.snippet) }))
      .filter((c) => c.segments.length > 0)
      // Stable sort by display order; equal ranks keep backend order.
      .map((c, i) => ({ c, i }))
      .sort((a, b) => order(a.c.field) - order(b.c.field) || a.i - b.i)
      .map(({ c }) => c);
    return {
      path: h.path,
      title: h.title,
      mtime_secs: h.mtime_secs,
      cards,
    };
  });
}

function segmentsEqual(
  a: readonly HighlightSegment[],
  b: readonly HighlightSegment[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.text === b[i]?.text && s.mark === b[i]?.mark);
}

function cardsEqual(a: readonly ResultCard[], b: readonly ResultCard[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (c, i) => c.field === b[i]?.field && segmentsEqual(c.segments, b[i]!.segments),
  );
}

function fileGroupEqual(a: FileGroup, b: FileGroup): boolean {
  return (
    a.title === b.title &&
    a.mtime_secs === b.mtime_secs &&
    cardsEqual(a.cards, b.cards)
  );
}

/**
 * `<For>` reconciles by object reference — reuse a previous group's
 * reference when its content is unchanged so a refetch that changed
 * another file's results (e.g. the debounced `vault:file-changed` tick
 * firing on the open file's own autosave) doesn't tear down and remount
 * every visible search result.
 */
export function buildStableFileGroups(
  prevGroups: readonly FileGroup[],
  hits: SearchHit[],
): FileGroup[] {
  return stabilizeByKey(prevGroups, buildFileGroups(hits), (g) => g.path, fileGroupEqual);
}
