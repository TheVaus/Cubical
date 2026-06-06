import type { MatchedField } from "../api/ipc";

/**
 * Snippet selection + highlight parsing for the search panel.
 *
 * The backend returns one `<mark>`-highlighted snippet per matched
 * field. `pickSnippet` chooses the most context-rich field to show in a
 * one-line result row; `parseHighlights` turns the snippet HTML into
 * plain segments the component renders as text nodes + <mark> spans
 * (never via innerHTML).
 */

/** Field preference for the single snippet shown per result row. */
const FIELD_PRIORITY = ["body", "headings", "code", "frontmatter", "title"];

export function pickSnippet(matched: MatchedField[]): MatchedField | null {
  for (const field of FIELD_PRIORITY) {
    const found = matched.find((m) => m.field === field);
    if (found) return found;
  }
  return matched.length > 0 ? matched[0] : null;
}

/** One run of snippet text, flagged as highlighted or not. */
export interface HighlightSegment {
  text: string;
  mark: boolean;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // last, so we don't double-unescape
}

/**
 * Split a Tantivy snippet on `<mark>` / `</mark>` into alternating
 * segments. Tantivy emits well-formed alternating tags, so a boolean
 * toggle tracks highlight state. Empty fragments are dropped but still
 * advance the toggle.
 */
export function parseHighlights(snippet: string): HighlightSegment[] {
  const parts = snippet.split(/<mark>|<\/mark>/);
  const segments: HighlightSegment[] = [];
  let mark = false;
  for (const part of parts) {
    if (part.length > 0) {
      segments.push({ text: unescapeHtml(part), mark });
    }
    mark = !mark;
  }
  return segments;
}
