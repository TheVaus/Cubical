// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import type { DataviewResult } from "../api/ipc";
import { editorBlocks } from "../shell/editorBlocks";
import { dataviewRunnerFacet, type DataviewRunner } from "./dataview";
import { livePreviewFor } from "./livePreview";

const PLUGINS = { math: true, equations: true, propertyRefs: true };
const DOC =
  "```csv\nname,role\nGandalf,Wizard\n```\n\n```query\nLIST\n```\n\ntail\n";

const RESULT: DataviewResult = { kind: "error", message: "stub" };

const runner: DataviewRunner = {
  get: () => RESULT,
  fetch: () => {},
  invalidate: () => {},
  onUpdate: () => () => {},
  version: () => 0,
  open: () => {},
};

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

function mount(blocks?: Extension): HTMLElement {
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: DOC.length },
      extensions: [
        markdown(),
        dataviewRunnerFacet.of(runner),
        livePreviewFor(false, PLUGINS, blocks),
      ],
    }),
  });
  return view.dom;
}

describe("live preview without the viewer and dataview blocks", () => {
  it("constructs and leaves csv and query fences as source", () => {
    const dom = mount();
    expect(dom.querySelector(".cm-csv-frame")).toBeNull();
    expect(dom.querySelector(".cm-dataview-frame")).toBeNull();
    expect(dom.textContent).toContain("Gandalf,Wizard");
    expect(dom.textContent).toContain("LIST");
  });

  it("renders both once the shell plugs the blocks in", () => {
    const dom = mount(editorBlocks);
    expect(dom.querySelector(".cm-csv-frame table")).not.toBeNull();
    expect(dom.querySelector(".cm-dataview-frame .cq-dataview-error")).not.toBeNull();
  });
});
