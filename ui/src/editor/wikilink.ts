/**
 * Lezer inline parser for `[[…]]` and `![[…]]` wiki-link tokens
 * (L3 Session B, spec §2.2).
 *
 * Emits a single `WikiLink` node spanning the entire token. No
 * sub-nodes — the decoration plugin re-tokenises the body with
 * `scanWikilinks` from `ui/src/ast/wikilink.ts` to find the visible
 * range (display ?? target) and the hide ranges (everything else).
 *
 * Runs `before: "Link"` so the default Lezer shortcut-Link rule does
 * not claim `[[X]]` as a Link with empty `dest`. This is the editor's
 * counterpart to the L1 normalizer's "re-flatten empty-dest Link/Image"
 * workaround (Session A, spec §5 deviation #1): in the editor we have
 * the luxury of installing the rule directly; the normalizer stays
 * untouched so the cross-language parity contract is unaffected.
 */

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t, styleTags } from "@lezer/highlight";

const CH_BANG = 33; // !
const CH_OPEN = 91; // [
const CH_CLOSE = 93; // ]

/**
 * Parse a wiki-link starting at `pos` (where `cx.char(pos)` returned
 * `next`). Returns the position past the closing `]]`, or `-1` if no
 * wiki-link starts here.
 */
function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  let contentStart: number;
  if (
    next === CH_BANG &&
    cx.char(pos + 1) === CH_OPEN &&
    cx.char(pos + 2) === CH_OPEN
  ) {
    contentStart = pos + 3;
  } else if (next === CH_OPEN && cx.char(pos + 1) === CH_OPEN) {
    contentStart = pos + 2;
  } else {
    return -1;
  }

  // Find the closing `]]`. Stay within the inline span (cx.end). `[[`
  // cannot nest — bail if we see another opener first.
  let close = -1;
  for (let p = contentStart; p + 1 < cx.end; p++) {
    const c = cx.char(p);
    if (c === CH_OPEN && cx.char(p + 1) === CH_OPEN) return -1;
    if (c === CH_CLOSE && cx.char(p + 1) === CH_CLOSE) {
      close = p;
      break;
    }
  }
  if (close < 0) return -1;

  // Reject empty target (matches scanWikilinks grammar — see
  // `ui/src/ast/wikilink.ts::parseBody`). Trim a target that may
  // include leading whitespace before `#` or `|`.
  const body = cx.slice(contentStart, close);
  const pipeIdx = body.indexOf("|");
  const headRaw = pipeIdx >= 0 ? body.slice(0, pipeIdx) : body;
  const hashIdx = headRaw.indexOf("#");
  const targetRaw = hashIdx >= 0 ? headRaw.slice(0, hashIdx) : headRaw;
  if (targetRaw.trim().length === 0) return -1;

  const tokenEnd = close + 2;
  return cx.addElement(cx.elt("WikiLink", pos, tokenEnd));
}

export const wikilinkExtension: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink", style: t.link }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CH_OPEN && next !== CH_BANG) return -1;
        return parseWikiLink(cx, next, pos);
      },
    },
  ],
  props: [
    styleTags({
      WikiLink: t.link,
    }),
  ],
};
