import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t, styleTags } from "@lezer/highlight";

const CH_BANG = 33;
const CH_OPEN = 91;
const CH_CLOSE = 93;

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
