/**
 * Lezer inline parser for `#tag` / `#parent/child` tokens
 * (L3 Session D, spec §2.4).
 *
 * Emits a single `Tag` node spanning the entire token. No sub-nodes —
 * the decoration plugin re-tokenises the body with `scanTags` from
 * `ui/src/ast/tag.ts` if it needs the bare path.
 *
 * Word-boundary rule: a `#` only opens a tag when it sits at the very
 * start of the inline span or directly follows an ASCII whitespace byte
 * (space, tab, newline). Mirrors `scan_tags` byte-for-byte so the
 * editor's syntax tree and the canonical AST agree on which `#` runs
 * are tags.
 *
 * Lezer's @lezer/markdown grammar handles code-span / fenced-code
 * exclusion automatically: this `parseInline` rule only fires inside
 * inline contexts, and `InlineCode` / `FencedCode` content is a leaf
 * span that no inline rule descends into. The L1 parity fixtures lock
 * the behaviour either way.
 */

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t, styleTags } from "@lezer/highlight";

const CH_HASH = 35; // #
const CH_SPACE = 32;
const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SLASH = 47;
const CH_UNDERSCORE = 95;
const CH_HYPHEN = 45;

function isAsciiWs(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR;
}

function isBodyStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === CH_UNDERSCORE
  );
}

function isBodyCont(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === CH_UNDERSCORE ||
    c === CH_HYPHEN
  );
}

/**
 * Parse a tag starting at `pos` (where `cx.char(pos)` returned `next`).
 * Returns the position past the last body character, or `-1` if no tag
 * starts here.
 */
function parseTag(cx: InlineContext, pos: number): number {
  // Word-boundary: the byte before the tag must be ASCII whitespace, or
  // the tag must sit at the start of the inline span. `cx.char` only
  // returns -1 past the span's *end*; for a position *before* the span's
  // offset it computes `charCodeAt(negative)` → `NaN`. Both sentinels
  // (`-1` and `NaN`) are < 0, so a single `prev >= 0` test treats either
  // out-of-bounds case as a span-start boundary. (Without this, a tag that
  // begins a paragraph whose offset > 0 — e.g. a tag alone on its own line
  // below the first block — saw `NaN`, was read as a non-whitespace char,
  // and was wrongly rejected.)
  if (pos > 0) {
    const prev = cx.char(pos - 1);
    if (prev >= 0 && !isAsciiWs(prev)) return -1;
  }
  const first = cx.char(pos + 1);
  if (first === -1 || !isBodyStart(first)) return -1;
  let p = pos + 2;
  while (p < cx.end) {
    const c = cx.char(p);
    if (isBodyCont(c)) {
      p++;
    } else if (c === CH_SLASH) {
      const next = cx.char(p + 1);
      if (next !== -1 && isBodyCont(next)) {
        p += 2;
        while (p < cx.end && isBodyCont(cx.char(p))) p++;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return cx.addElement(cx.elt("Tag", pos, p));
}

export const tagExtension: MarkdownConfig = {
  defineNodes: [{ name: "Tag", style: t.labelName }],
  parseInline: [
    {
      name: "Tag",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CH_HASH) return -1;
        return parseTag(cx, pos);
      },
    },
  ],
  props: [
    styleTags({
      Tag: t.labelName,
    }),
  ],
};
