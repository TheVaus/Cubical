// @vitest-environment jsdom
/**
 * Full-EditorView regression tests for editor-surface navigation
 * (Contract 2 of L4-A-fix). The atomic block-replace contract over
 * the WikiLink node's byte span means CM6 treats the embed as a
 * single steppable unit; cursor up/down arrow keys traverse it
 * cleanly rather than jumping to document boundaries.
 *
 * Regression for kickoff bug #6: previously, up-arrow in a file
 * containing an embed jumped to the start of the document.
 *
 * Note on jsdom limits: jsdom does not implement DOM layout, so the
 * exact-pixel coords path CM6 uses for vertical motion can't fully
 * reproduce the broken behavior of the old line-end `Decoration.widget`.
 * We stub `Range.getBoundingClientRect` / `Element.getBoundingClientRect`
 * so `cursorLineUp` / `cursorLineDown` return rather than throwing;
 * the assertions verify only that the head lands at a sensible
 * non-zero position somewhere between the embed line and the source
 * paragraph. The byte-exact contract — `Decoration.replace({block:true})`
 * over `[node.from, node.to)` — is asserted structurally in
 * `embed.test.ts`. End-to-end visual cursor traversal lives with the
 * §9.x interactive smoke pass.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cursorLineUp, cursorLineDown } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

// jsdom does not implement `Range.getClientRects` / `getBoundingClientRect`,
// which CM6's vertical-motion path calls via `EditorView.coordsAtPos`.
// We stub them to return a deterministic single-line-height layout so
// `cursorLineUp` / `cursorLineDown` resolve to a sensible target line
// rather than throwing. The numerical coordinates don't have to be
// "correct" — they only have to be self-consistent so CM6's "find the
// line above/below this Y" search terminates.
beforeAll(() => {
  const proto = (global as unknown as { Range: { prototype: Range } }).Range
    .prototype;
  if (typeof proto.getClientRects !== "function" || proto.getClientRects.length === 0) {
    // jsdom either omits the method or stubs it to throw — replace with
    // a per-DOM-position deterministic rect derived from the parent
    // element's bounding box plus the range's offset, so each visual
    // line gets a distinct Y.
    proto.getClientRects = function (this: Range): DOMRectList {
      const r = this.getBoundingClientRect();
      const list: DOMRectList = Object.assign([r] as DOMRect[], {
        item: (i: number) => list[i] ?? null,
      }) as unknown as DOMRectList;
      return list;
    };
  }
  const elProto = (global as unknown as { Element: { prototype: Element } })
    .Element.prototype;
  const origGBCR = elProto.getBoundingClientRect;
  elProto.getBoundingClientRect = function (this: Element): DOMRect {
    // Use the element's index in its parent's children as a stand-in
    // for vertical position; multiplied by a nominal line height so
    // CM6's coordsAtPos search can compare "above" vs "below".
    let top = 0;
    let cur: Element | null = this;
    while (cur) {
      let prev: Element | null = cur.previousElementSibling;
      while (prev) {
        top += 16;
        prev = prev.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    const orig = origGBCR.call(this) as DOMRect;
    const rect: DOMRect = {
      x: 0,
      y: top,
      top,
      bottom: top + 16,
      left: 0,
      right: 100,
      width: 100,
      height: 16,
      toJSON: () => orig,
    };
    return rect;
  };
  // Range.getBoundingClientRect — use the start container's element.
  const rangeProto = (global as unknown as { Range: { prototype: Range } })
    .Range.prototype;
  rangeProto.getBoundingClientRect = function (this: Range): DOMRect {
    const node =
      this.startContainer.nodeType === 1
        ? (this.startContainer as Element)
        : this.startContainer.parentElement;
    return node ? node.getBoundingClientRect() : ({
      x: 0,
      y: 0,
      top: 0,
      bottom: 16,
      left: 0,
      right: 0,
      width: 0,
      height: 16,
      toJSON: () => ({}),
    } as DOMRect);
  };
});

import { livePreviewBundle } from "./livePreview";
import { wikilinkExtension } from "./wikilink";
import { tagExtension } from "./tag";
import {
  embedResolverFacet,
  openNotePathFacet,
} from "./embed";
import { wikilinkResolverFacet } from "./decorations";

const RESOLVED_EMBED = {
  kind: "note" as const,
  target_path: "Daily.md",
  content: "embed body",
};

function makeResolver() {
  return {
    get: () => RESOLVED_EMBED,
    fetch: () => undefined,
    resolve: async () => RESOLVED_EMBED,
    invalidate: () => undefined,
    onUpdate: () => () => undefined,
  };
}

function mountView(doc: string, selectionAnchor: number): {
  view: EditorView;
  host: HTMLElement;
} {
  const compartment = new Compartment();
  const state = EditorState.create({
    doc,
    selection: { anchor: selectionAnchor },
    extensions: [
      markdown({ extensions: [wikilinkExtension, tagExtension] }),
      embedResolverFacet.of(makeResolver()),
      openNotePathFacet.of(null),
      wikilinkResolverFacet.of(null),
      compartment.of(livePreviewBundle),
    ],
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({ state, parent: host });
  return { view, host };
}

describe("cursor navigation across embed widgets (bug #6 regression)", () => {
  it("up-arrow from the line after the embed lands on the embed's host line, not doc start", () => {
    const doc = "para 1\n\n![[Daily]]\n\npara 2\n";
    const para2Start = doc.indexOf("para 2");
    const { view, host } = mountView(doc, para2Start + 2);
    try {
      cursorLineUp(view);
      const head = view.state.selection.main.head;
      expect(head).toBeGreaterThan(0);
      expect(head).toBeLessThan(para2Start + 2);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("down-arrow from the line before the embed traverses toward the embed", () => {
    const doc = "para 1\n\n![[Daily]]\n\npara 2\n";
    const para1Mid = "para".length;
    const { view, host } = mountView(doc, para1Mid);
    try {
      cursorLineDown(view);
      const head = view.state.selection.main.head;
      expect(head).toBeGreaterThan(para1Mid);
      expect(head).toBeLessThan(doc.length);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
