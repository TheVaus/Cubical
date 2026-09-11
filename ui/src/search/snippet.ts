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
    .replace(/&amp;/g, "&");
}

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
