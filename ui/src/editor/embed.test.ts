// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";

import { wikilinkExtension } from "./wikilink";
import { tagExtension } from "./tag";
import {
  embedBlockField,
  embedExtension,
  embedResolverFacet,
  openNotePathFacet,
  embedResolverUpdated,
} from "./embed";
import type { EmbedResolver, EmbedResolution } from "./embedResolver";

function makeStubResolver(resp: EmbedResolution): EmbedResolver {
  return {
    get: () => resp,
    fetch: () => undefined,
    resolve: async () => resp,
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

function stubResolver(entries: Record<string, EmbedResolution>): EmbedResolver {
  return {
    get: (t) => entries[t],
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
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

function makeView(
  doc: string,
  resolver: EmbedResolver | null,
  selectionAnchor?: number,
): EditorView {
  const host = document.createElement("div");
  // Default the cursor to doc end so the embed's host line is *not*
  // the active line — otherwise the Contract 2 cursor-line suppression
  // would hide every embed under test. Tests that need cursor-on-host
  // -line behavior set `selectionAnchor` explicitly.
  const anchor = selectionAnchor ?? doc.length;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        embedResolverFacet.of(resolver),
        openNotePathFacet.of(null),
        embedExtension,
      ],
    }),
  });
  return view;
}

function widgetCount(view: EditorView): number {
  let n = 0;
  view.contentDOM
    .querySelectorAll(".cm-md-embed-frame")
    .forEach(() => {
      n++;
    });
  return n;
}

describe("embedExtension", () => {
  it("emits no widget when the doc has no ![[…]]", () => {
    const r = stubResolver({});
    const view = makeView("plain text\n", r);
    expect(widgetCount(view)).toBe(0);
    view.destroy();
  });

  it("emits a widget for an ![[…]] token", () => {
    const r = stubResolver({
      Daily: { kind: "note", target_path: "Daily.md", content: "hi" },
    });
    const view = makeView("see ![[Daily]] please\n", r);
    expect(widgetCount(view)).toBe(1);
    view.destroy();
  });

  it("does not emit a widget for a plain [[…]] token (no embed flag)", () => {
    const r = stubResolver({});
    const view = makeView("see [[Daily]] please\n", r);
    expect(widgetCount(view)).toBe(0);
    view.destroy();
  });

  it("emits one widget per ![[…]] on a multi-embed line", () => {
    const r = stubResolver({
      A: { kind: "note", target_path: "A.md", content: "a" },
      B: { kind: "note", target_path: "B.md", content: "b" },
    });
    const view = makeView("![[A]] and ![[B]]\n", r);
    expect(widgetCount(view)).toBe(2);
    view.destroy();
  });

  it("rebuilds on embedResolverUpdated effect (no doc change)", () => {
    // Cold cache first — widget renders a Loading placeholder.
    const entries: Record<string, EmbedResolution> = {};
    // `ver` mirrors the real resolver: bumps on every cache mutation,
    // which is what drives the widget's remount (Contract 2 / bug #5).
    let ver = 0;
    const r: EmbedResolver = {
      get: (t) => entries[t],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
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
      version: () => ver,
    };
    const view = makeView("![[Daily]]\n", r);
    expect(
      view.contentDOM.querySelector(".cm-md-embed-loading"),
    ).not.toBeNull();

    // Populate the cache and fire the effect — widget should repaint
    // to the resolved body.
    entries.Daily = {
      kind: "note",
      target_path: "Daily.md",
      content: "hi",
    };
    ver++;
    view.dispatch({ effects: embedResolverUpdated.of(null) });
    expect(view.contentDOM.querySelector(".cm-md-embed-body")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-md-embed-loading")).toBeNull();
    view.destroy();
  });

  it("renders a cycle link when openNotePathFacet matches the embed target", () => {
    const r = stubResolver({
      Self: { kind: "note", target_path: "Self.md", content: "x" },
    });
    const host = document.createElement("div");
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "![[Self]]\n",
        // Cursor at end (line 2 — blank) so Contract 2 cursor-line
        // suppression does not hide the widget under test.
        selection: { anchor: "![[Self]]\n".length },
        extensions: [
          markdown({ extensions: [wikilinkExtension] }),
          embedResolverFacet.of(r),
          openNotePathFacet.of("Self.md"),
          embedExtension,
        ],
      }),
    });
    expect(
      view.contentDOM.querySelector(".cm-md-embed-link-cycle"),
    ).not.toBeNull();
    view.destroy();
  });

  it("preserves widget DOM identity across an unrelated doc edit", () => {
    // Issue 1 regression guard: with the old `Date.now()` stamp every
    // rebuild produced a fresh widget identity and CM6 remounted the
    // frame; with entry-reference identity an unrelated edit leaves
    // the embed's DOM node intact.
    const r = stubResolver({
      Daily: { kind: "note", target_path: "Daily.md", content: "hi" },
    });
    const view = makeView("![[Daily]]\nplain second line\n", r);
    const frameBefore = view.contentDOM.querySelector(".cm-md-embed-frame");
    expect(frameBefore).not.toBeNull();

    view.dispatch({
      changes: {
        from: view.state.doc.line(2).from,
        insert: "EDIT ",
      },
    });

    const frameAfter = view.contentDOM.querySelector(".cm-md-embed-frame");
    expect(frameAfter).toBe(frameBefore);
    view.destroy();
  });

  it("remounts the widget when the resolver version bumps (cold → resolved)", () => {
    // Companion to the identity-preservation test: when the resolver
    // cache mutates (cold → resolved) it bumps `version()`, the new
    // widget's `eq()` returns false, and CM6 remounts the DOM.
    const entries: Record<string, EmbedResolution> = {};
    let ver = 0;
    const r: EmbedResolver = {
      get: (t) => entries[t],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
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
      version: () => ver,
    };
    const view = makeView("![[Daily]]\n", r);
    const loadingFrame = view.contentDOM.querySelector(".cm-md-embed-frame");
    expect(loadingFrame).not.toBeNull();

    entries.Daily = {
      kind: "note",
      target_path: "Daily.md",
      content: "hi",
    };
    ver++;
    view.dispatch({ effects: embedResolverUpdated.of(null) });

    const resolvedFrame = view.contentDOM.querySelector(".cm-md-embed-frame");
    expect(resolvedFrame).not.toBeNull();
    expect(resolvedFrame).not.toBe(loadingFrame);
    expect(view.contentDOM.querySelector(".cm-md-embed-body")).not.toBeNull();
    view.destroy();
  });

  // Sanity that the markdown grammar + wikilink extension still parses
  // an embed token as a WikiLink node — guards against an upstream
  // regression that would silently hide the widget.
  it("parses ![[…]] as a single WikiLink node", () => {
    const view = makeView("![[Daily]]\n", null);
    const tree = syntaxTree(view.state);
    let found = 0;
    tree.iterate({
      enter: (node) => {
        if (node.name === "WikiLink") found++;
      },
    });
    expect(found).toBe(1);
    view.destroy();
  });

  // Fixtures use a MID-LINE embed (`see ![[Daily]] inline`) — the real
  // vault shape (`embeds: ![[B]]`). The two-decoration block model emits
  // (1) an inline NON-widget replace hiding the token bytes [bug #6:
  // cursor steps over it], and (2) a BLOCK widget at the host line's end
  // rendering the card [no "invisible until click"]. Earlier fixtures
  // put the embed alone on its line, masking the mid-line cases.
  const MIDLINE_DOC = "para 1\n\nsee ![[Daily]] inline\n\npara 2\n";
  const EMBED_FROM = MIDLINE_DOC.indexOf("![[Daily]]");
  const EMBED_TO = EMBED_FROM + "![[Daily]]".length;
  // End of the host line ("see ![[Daily]] inline") — where the block
  // widget anchors.
  const HOST_LINE_TO = MIDLINE_DOC.indexOf("\n", EMBED_TO);

  it("emits an inline token-hide AND a block widget at the host line end", () => {
    const state = EditorState.create({
      doc: MIDLINE_DOC,
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(makeStubResolver({
          kind: "note",
          target_path: "Daily.md",
          content: "loaded",
        })),
        openNotePathFacet.of(null),
        embedBlockField,
      ],
      selection: { anchor: 0 }, // cursor off the embed line
    });

    let inlineHide: { from: number; to: number } | null = null;
    let blockWidget: { from: number; to: number } | null = null;
    state.field(embedBlockField).between(0, state.doc.length, (from, to, v) => {
      if (v.spec?.widget && v.spec?.block === true) {
        blockWidget = { from, to };
      } else if (!v.spec?.widget) {
        inlineHide = { from, to };
      }
    });

    // 1. Inline hide over exactly the token bytes, NOT block.
    expect(inlineHide).toEqual({ from: EMBED_FROM, to: EMBED_TO });
    // 2. Block widget anchored at the host line's end.
    expect(blockWidget).toEqual({ from: HOST_LINE_TO, to: HOST_LINE_TO });
  });

  it("renders the embed card in a real EditorView without throwing", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({
        doc: MIDLINE_DOC,
        extensions: [
          markdown({ extensions: [wikilinkExtension, tagExtension] }),
          embedResolverFacet.of(makeStubResolver({
            kind: "note",
            target_path: "Daily.md",
            content: "loaded",
          })),
          openNotePathFacet.of(null),
          embedBlockField,
        ],
        selection: { anchor: 0 },
      }),
      parent: host,
    });
    try {
      // The block widget's card frame rendered somewhere in the view.
      expect(view.dom.querySelector(".cm-md-embed-frame")).not.toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("suppresses both decorations when the cursor is on the embed's host line", () => {
    const state = EditorState.create({
      doc: MIDLINE_DOC,
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(makeStubResolver({
          kind: "note",
          target_path: "Daily.md",
          content: "loaded",
        })),
        openNotePathFacet.of(null),
        embedBlockField,
      ],
      selection: { anchor: EMBED_FROM + 1 }, // inside ![[Daily]]
    });

    let count = 0;
    state.field(embedBlockField).between(0, state.doc.length, () => {
      count++;
    });
    expect(count).toBe(0);
  });

  it("rebuilds and toggles both decorations when the cursor crosses the line", () => {
    const state0 = EditorState.create({
      doc: MIDLINE_DOC,
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(makeStubResolver({
          kind: "note",
          target_path: "Daily.md",
          content: "loaded",
        })),
        openNotePathFacet.of(null),
        embedBlockField,
      ],
      selection: { anchor: 0 }, // line 1 — far from embed
    });

    const set0 = state0.field(embedBlockField);
    const tr = state0.update({ selection: { anchor: EMBED_FROM + 1 } });
    const set1 = tr.state.field(embedBlockField);

    expect(set0).not.toBe(set1);

    const countOf = (set: typeof set0) => {
      let n = 0;
      set.between(0, MIDLINE_DOC.length, () => {
        n++;
      });
      return n;
    };
    // Off the line: inline hide + block widget = 2 decorations.
    expect(countOf(set0)).toBe(2);
    // On the line: suppressed → 0.
    expect(countOf(set1)).toBe(0);
  });

  it("bug #5: widget identity changes when the resolver version bumps (nested embed resolves)", () => {
    // A embeds B; B's content embeds C. Initially only B is cached and
    // the resolver reports version 0. When the nested C resolves the
    // resolver bumps its version — the top-level widget's identity must
    // change so CM6 remounts and re-renders the now-resolved nested
    // embed (instead of freezing on `Loading [[C]]…`).
    let version = 0;
    const cache: Record<string, EmbedResolution> = {
      B: { kind: "note", target_path: "B.md", content: "see ![[C]] nested" },
    };
    const resolver: EmbedResolver = {
      get: (t) => cache[t],
      fetch: () => undefined,
      resolve: async () =>
        cache.B ?? { kind: "unresolved", target_path: null, content: null },
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
      debug: () => ({
        cacheSize: Object.keys(cache).length,
        inFlight: [],
        lastFetchAt: new Map(),
        lastSettleAt: new Map(),
        lastError: new Map(),
      }),
      onEvent: () => () => undefined,
      abort: () => undefined,
      version: () => version,
    };

    const doc = "host\n\nsee ![[B]] here\n\n\n";
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(resolver),
        openNotePathFacet.of("A.md"),
        embedBlockField,
      ],
    });

    type EqWidget = { eq: (o: unknown) => boolean };
    const widgetOf = (s: EditorState): EqWidget | null => {
      let w: EqWidget | null = null;
      s.field(embedBlockField).between(0, doc.length, (_f, _t, v) => {
        const widget = v.spec?.widget;
        if (widget) w = widget as unknown as EqWidget;
      });
      return w;
    };

    const w1 = widgetOf(state);
    expect(w1).not.toBeNull();

    // Nested C resolves: cache grows and the version bumps.
    cache.C = { kind: "note", target_path: "C.md", content: "C body" };
    version++;

    const tr = state.update({ effects: embedResolverUpdated.of(null) });
    const w2 = widgetOf(tr.state);
    expect(w2).not.toBeNull();

    // Identity MUST differ → CM6 remounts → nested embed re-renders.
    expect(w1!.eq(w2)).toBe(false);
  });
});
