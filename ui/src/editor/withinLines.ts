import type { Text } from "@codemirror/state";

export function withinLines<R extends { from: number; to: number }>(
  doc: Text,
  range: R,
): R[] {
  const parts: R[] = [];
  for (let from = range.from; from < range.to; ) {
    const line = doc.lineAt(from);
    const to = Math.min(range.to, line.to);
    if (to > from) parts.push({ ...range, from, to });
    from = line.to + 1;
  }
  return parts;
}
