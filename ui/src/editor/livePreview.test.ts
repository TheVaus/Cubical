import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

import { livePreviewBundle } from "./livePreview";
import { wikilinkExtension } from "./wikilink";
import { tagExtension } from "./tag";
import {
  embedBlockField,
  embedResolverFacet,
  openNotePathFacet,
} from "./embed";
import { wikilinkResolverFacet } from "./decorations";

// Minimal stub resolver — produces a cached "note" entry for every key.
const stubEmbedResolver = {
  get: () => ({
    kind: "note" as const,
    target_path: "Daily.md",
    content: "stub",
  }),
  fetch: () => undefined,
  resolve: async () => ({
    kind: "note" as const,
    target_path: "Daily.md",
    content: "stub",
  }),
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

describe("livePreviewBundle", () => {
  it("composes the embed StateField (resolved by state.field without throwing)", () => {
    const state = EditorState.create({
      doc: "# Heading\n\n![[Daily]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(stubEmbedResolver),
        openNotePathFacet.of(null),
        wikilinkResolverFacet.of(null),
        livePreviewBundle,
      ],
    });
    expect(() => state.field(embedBlockField)).not.toThrow();
  });

  it("emits the embed block widget when the cursor is elsewhere", () => {
    // Mid-line embed (real vault shape). The bundle must emit the
    // two-decoration block model: an inline token-hide plus a block
    // widget rendering the card.
    const doc = "# Heading\n\nsee ![[Daily]] inline\n\ntail\n";
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(stubEmbedResolver),
        openNotePathFacet.of(null),
        wikilinkResolverFacet.of(null),
        livePreviewBundle,
      ],
    });

    const set = state.field(embedBlockField);
    let blockWidget = false;
    let inlineHide = false;
    set.between(0, doc.length, (_from, _to, value) => {
      if (value.spec?.widget && value.spec?.block === true) blockWidget = true;
      else if (!value.spec?.widget) inlineHide = true;
    });
    expect(blockWidget).toBe(true);
    expect(inlineHide).toBe(true);
  });

  it("the bundle is the contract: outside the bundle, embedBlockField is not registered", () => {
    const state = EditorState.create({
      doc: "![[Daily]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(stubEmbedResolver),
        openNotePathFacet.of(null),
        wikilinkResolverFacet.of(null),
      ],
    });
    expect(() => state.field(embedBlockField)).toThrow();
  });
});
