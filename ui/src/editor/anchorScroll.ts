import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export function findHeadingOffset(
  state: EditorState,
  value: string,
): number | null {
  const target = value.trim();
  if (target.length === 0) return null;
  let found: number | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found !== null) return false;
      if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return undefined;
      const line = state.doc.lineAt(node.from);
      const atx = line.text.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
      const text = (atx?.[1] ?? line.text).trim();
      if (text === target) {
        found = line.from;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function isAllowedBlockId(id: string): boolean {
  return id.length > 0 && /^[\p{L}\p{N}_-]+$/u.test(id);
}

export function findBlockDefinitionOffset(
  doc: string,
  blockId: string,
): number | null {
  if (!isAllowedBlockId(blockId)) return null;
  const needle = `^${blockId}`;

  let lineStart = 0;
  for (let i = 0; i <= doc.length; i++) {
    if (i === doc.length || doc[i] === "\n") {
      const line = doc.slice(lineStart, i);
      const trimmedEnd = line.replace(/\s+$/u, "");
      const lastWsIdx = trimmedEnd.search(/\s\S*$/u);
      const token =
        lastWsIdx >= 0 ? trimmedEnd.slice(lastWsIdx + 1) : trimmedEnd;
      if (token === needle) return lineStart;
      lineStart = i + 1;
    }
  }
  return null;
}
