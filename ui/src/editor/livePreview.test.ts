import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

import { livePreviewFor } from "./livePreview";
import { editorBlocks } from "../shell/editorBlocks";

const ALL_ON = { math: true, equations: true, propertyRefs: true };
import { wikilinkExtension } from "./wikilink";
import { tagExtension } from "./tag";
import {
  embedBlockField,
  embedResolverFacet,
  openNotePathFacet,
} from "./embed";
import { wikilinkResolverFacet } from "./decorations";

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
  markStale: () => undefined,
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

describe("livePreviewFor with the shell's blocks", () => {
  it("composes the embed StateField (resolved by state.field without throwing)", () => {
    const state = EditorState.create({
      doc: "# Heading\n\n![[Daily]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(stubEmbedResolver),
        openNotePathFacet.of(null),
        wikilinkResolverFacet.of(null),
        livePreviewFor(false, ALL_ON, editorBlocks),
      ],
    });
    expect(() => state.field(embedBlockField)).not.toThrow();
  });

  it("emits the embed block card when the embed is alone on its line", () => {
    const doc = "# Heading\n\n![[Daily]]\n\ntail\n";
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        embedResolverFacet.of(stubEmbedResolver),
        openNotePathFacet.of(null),
        wikilinkResolverFacet.of(null),
        livePreviewFor(false, ALL_ON, editorBlocks),
      ],
    });

    const set = state.field(embedBlockField);
    let blockReplace = false;
    set.between(0, doc.length, (_from, _to, value) => {
      if (value.spec?.widget && value.spec?.block === true) blockReplace = true;
    });
    expect(blockReplace).toBe(true);
  });

  it("live preview is the contract: outside it, embedBlockField is not registered", () => {
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
