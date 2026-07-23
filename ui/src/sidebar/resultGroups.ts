import type { SearchHit } from "../api/ipc";
import { stabilizeByKey } from "../listStability";
import { parseHighlights, type HighlightSegment } from "./snippet";

const CARD_ORDER = ["body", "headings", "code", "frontmatter", "title"];

export interface ResultCard {
  field: string;
  segments: HighlightSegment[];
}

export interface FileGroup {
  path: string;
  title: string;
  mtime_secs: number;
  cards: ResultCard[];
}

function order(field: string): number {
  const i = CARD_ORDER.indexOf(field);
  return i === -1 ? CARD_ORDER.length : i;
}

export function buildFileGroups(hits: SearchHit[]): FileGroup[] {
  return hits.map((h) => {
    const cards = h.matched_fields
      .map((m) => ({ field: m.field, segments: parseHighlights(m.snippet) }))
      .filter((c) => c.segments.length > 0)
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

export function buildStableFileGroups(
  prevGroups: readonly FileGroup[],
  hits: SearchHit[],
): FileGroup[] {
  return stabilizeByKey(prevGroups, buildFileGroups(hits), (g) => g.path, fileGroupEqual);
}
