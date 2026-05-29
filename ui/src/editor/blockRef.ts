/**
 * Pure helpers for the "Copy block reference" gesture (L3 Session G
 * frontend). The gesture mints a `^block-id` via the backend and copies
 * a `[[path#^id]]` wiki-link; these two functions are the testable
 * pieces of that flow.
 */

/**
 * UTF-8 byte offset of `charPos` (a CodeMirror UTF-16 code-unit
 * position) into `text`. `create_block_ref` locates the target line by
 * byte offset, so the gesture must convert CM's char positions before
 * sending them.
 */
export function byteOffsetOf(text: string, charPos: number): number {
  return new TextEncoder().encode(text.slice(0, charPos)).length;
}

/**
 * Build the wiki-link to copy: `[[<path-without-.md>#^<blockId>]]`.
 * Stripping `.md` yields an exact vault-relative path match, which
 * resolves unambiguously even when two notes share a basename.
 */
export function buildBlockRefLink(path: string, blockId: string): string {
  const base = path.endsWith(".md") ? path.slice(0, -3) : path;
  return `[[${base}#^${blockId}]]`;
}
