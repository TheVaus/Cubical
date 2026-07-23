// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cursorLineUp, cursorLineDown } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

beforeAll(() => {
  const proto = (global as unknown as { Range: { prototype: Range } }).Range
    .prototype;
  if (typeof proto.getClientRects !== "function" || proto.getClientRects.length === 0) {
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
    debug: () => ({
      cacheSize: 0,
      inFlight: [],
      lastFetchAt: new Map(),
      lastSettleAt: new Map(),
      lastError: new Map(),
    }),
    onEvent: () => () => undefined,
    abort: () => undefined,
    version: () => 0,
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
