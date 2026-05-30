// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";

import { wikilinkExtension } from "./wikilink";
import {
  embedExtension,
  embedResolverFacet,
  openNotePathFacet,
  embedResolverUpdated,
} from "./embed";
import type { EmbedResolver, EmbedResolution } from "./embedResolver";

function stubResolver(entries: Record<string, EmbedResolution>): EmbedResolver {
  return {
    get: (t) => entries[t],
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
    invalidate: () => undefined,
    onUpdate: () => () => undefined,
  };
}

function makeView(doc: string, resolver: EmbedResolver | null): EditorView {
  const host = document.createElement("div");
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
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
    const r: EmbedResolver = {
      get: (t) => entries[t],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
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

  it("remounts the widget when its resolver entry changes", () => {
    // Companion to the identity-preservation test: when the resolver
    // cache *does* flip the entry (cold → resolved), the new widget's
    // `eq()` returns false and CM6 remounts the DOM.
    const entries: Record<string, EmbedResolution> = {};
    const r: EmbedResolver = {
      get: (t) => entries[t],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
    };
    const view = makeView("![[Daily]]\n", r);
    const loadingFrame = view.contentDOM.querySelector(".cm-md-embed-frame");
    expect(loadingFrame).not.toBeNull();

    entries.Daily = {
      kind: "note",
      target_path: "Daily.md",
      content: "hi",
    };
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
});
