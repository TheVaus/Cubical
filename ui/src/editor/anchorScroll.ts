/**
 * Pure locators for wiki-link anchor targets within a document's raw
 * source. DOM-free so they unit-test cleanly; the CodeMirror glue in
 * `Editor.tsx` turns the returned offset into a `scrollIntoView`.
 *
 * The block-definition rule mirrors the Rust trailing-token logic in
 * `crates/cubical-core/src/vault/pending.rs::rewrite_block_ref_defining_line`:
 * a block id is defined when a line's final whitespace-delimited token
 * is exactly `^<id>`, where the id charset is Unicode letters/digits /
 * `_` / `-`.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/**
 * Return the document offset of the first heading whose plain-text
 * content equals `value` (trimmed), or `null` when none matches. ATX
 * (`## Foo`) markers and trailing `#`s are stripped; Setext headings use
 * their content line. Pure over an `EditorState` (no DOM) so it tests in
 * node. Note: matching is exact against the raw heading text, so inline
 * markup in the heading (`## **Foo**`) is not yet normalized away.
 */
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

/** Block-id charset: Unicode letters/digits + `_` + `-`. Empty rejected. */
function isAllowedBlockId(id: string): boolean {
  return id.length > 0 && /^[\p{L}\p{N}_-]+$/u.test(id);
}

/**
 * Return the character offset of the start of the line that *defines*
 * `blockId` (its trailing token is `^<blockId>`), or `null` when the id
 * is invalid or no defining line exists.
 */
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
      // The defining token is the final whitespace-delimited word.
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
