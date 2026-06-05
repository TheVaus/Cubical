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

  // Task 2 enables this test: it asserts the new atomic block-replace
  // behavior. The current embed.ts emits `Decoration.widget({ block: true,
  // side: 1 }).range(line.to)` — a non-replace widget at the line's end
  // position. Task 2 switches to `Decoration.replace({ widget, block: true })`
  // and this assertion will then hold.
  it.skip("emits a block-replace decoration over an embed token when the cursor is elsewhere", () => {
    const state = EditorState.create({
      doc: "# Heading\n\n![[Daily]]\n\ntail\n",
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
    const embedFrom = "# Heading\n\n".length;
    const embedTo = embedFrom + "![[Daily]]".length;

    let found = false;
    set.between(embedFrom, embedTo, (from, to, value) => {
      if (
        from === embedFrom &&
        to === embedTo &&
        value.spec?.widget !== undefined &&
        value.spec?.block === true
      ) {
        found = true;
      }
    });
    expect(found).toBe(true);
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
