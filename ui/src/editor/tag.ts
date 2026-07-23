import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t, styleTags } from "@lezer/highlight";

const CH_HASH = 35;
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

function parseTag(cx: InlineContext, pos: number): number {
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
