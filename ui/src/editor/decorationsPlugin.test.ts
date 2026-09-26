// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import {
  livePreviewDecorations,
  wikilinkResolverFacet,
  type WikiLinkResolverFacetValue,
} from "./decorations";
import { wikilinkExtension } from "./wikilink";

function recorder(): WikiLinkResolverFacetValue & { fetched: string[] } {
  const fetched: string[] = [];
  return { fetched, get: () => undefined, fetch: (t) => fetched.push(t) };
}

function mount(doc: string, resolver: WikiLinkResolverFacetValue) {
  const slot = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        slot.of(wikilinkResolverFacet.of(resolver)),
        livePreviewDecorations,
      ],
    }),
  });
  return { view, slot };
}

describe("live preview plugin", () => {
  it("fetches every uncached wiki-link it decorates", () => {
    const r = recorder();
    const { view } = mount("[[a]] and [[b]]\n\ntail", r);
    expect(r.fetched.sort()).toEqual(["a", "b"]);
    view.destroy();
  });

  it("re-resolves against a swapped resolver without waiting for an edit", () => {
    const first = recorder();
    const { view, slot } = mount("[[a]]\n\ntail", first);
    const second = recorder();
    view.dispatch({
      effects: slot.reconfigure(wikilinkResolverFacet.of(second)),
    });
    expect(second.fetched).toEqual(["a"]);
    view.destroy();
  });
});
