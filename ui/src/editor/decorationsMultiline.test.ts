// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { livePreviewDecorations } from "./decorations";
import { wikilinkExtension } from "./wikilink";

function mount(doc: string): () => void {
  return () => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          markdown({ extensions: [wikilinkExtension] }),
          livePreviewDecorations,
        ],
      }),
    });
    view.destroy();
  };
}

describe("live preview over constructs that span a line break", () => {
  it("opens a paragraph with a wikilink target broken across lines", () => {
    expect(mount("top\n\nsee [[Some\nNote|alias]] here")).not.toThrow();
  });

  it("opens a paragraph with a wikilink heading broken across lines", () => {
    expect(mount("top\n\nsee [[Note#Head\ning]] here")).not.toThrow();
  });

  it("opens a paragraph with a link title broken across lines", () => {
    expect(mount('top\n\nsee [x](/u "t1\nt2") here')).not.toThrow();
  });
});
