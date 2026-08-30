// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import {
  blockRenderers,
  blockRenderersField,
  languageForInfo,
  matchRenderer,
  type BlockRenderer,
} from "./blockRenderers";

function textRenderer(
  id: string,
  languages: string[],
  overrides: Partial<BlockRenderer> = {},
): BlockRenderer {
  return {
    id,
    languages,
    frameClass: `cm-block-frame cm-${id}-frame`,
    render: (source, ctx) => {
      const el = document.createElement("pre");
      el.dataset.renderer = id;
      el.dataset.language = ctx.language;
      el.textContent = source;
      return el;
    },
    ...overrides,
  };
}

function stateWith(
  doc: string,
  renderers: BlockRenderer[],
  cursor = 0,
): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown(), blockRenderersField, blockRenderers(...renderers)],
  });
}

function countRanges(set: DecorationSet): number {
  let n = 0;
  set.between(0, 1e9, () => {
    n += 1;
  });
  return n;
}

function rendered(doc: string, renderers: BlockRenderer[], cursor = 0) {
  const view = new EditorView({ state: stateWith(doc, renderers, cursor) });
  const nodes = [...view.dom.querySelectorAll("[data-renderer]")].map((n) => ({
    renderer: (n as HTMLElement).dataset.renderer,
    language: (n as HTMLElement).dataset.language,
    text: n.textContent,
  }));
  view.destroy();
  return nodes;
}

describe("languageForInfo", () => {
  it("normalizes case and whitespace", () => {
    expect(languageForInfo("  MATH  ")).toBe("math");
  });

  it("takes only the first token so ```math {tag} still matches", () => {
    expect(languageForInfo("math {caption=x}")).toBe("math");
  });

  it("is empty for a bare fence", () => {
    expect(languageForInfo("   ")).toBe("");
  });
});

describe("matchRenderer", () => {
  const renderers = [
    textRenderer("a", ["alpha"]),
    textRenderer("b", ["beta", "gamma"]),
  ];

  it("reports which language matched, not just the renderer", () => {
    expect(matchRenderer(renderers, "  BETA ")?.language).toBe("beta");
  });

  it("matches any of a renderer's languages", () => {
    expect(matchRenderer(renderers, "gamma")?.renderer.id).toBe("b");
  });

  it("returns undefined for an unregistered language", () => {
    expect(matchRenderer(renderers, "rust")).toBeUndefined();
  });

  it("returns undefined for a bare fence", () => {
    expect(matchRenderer(renderers, "")).toBeUndefined();
  });
});

describe("blockRenderersField", () => {
  const alpha = textRenderer("a", ["alpha"]);

  it("routes a fenced block to the renderer that registered its language", () => {
    const doc = "text\n\n```alpha\nbody\n```\n\ntrailing\n";
    expect(rendered(doc, [alpha], 0)).toEqual([
      { renderer: "a", language: "alpha", text: "body" },
    ]);
  });

  it("passes the matched language so one renderer can serve several", () => {
    const multi = textRenderer("m", ["csv", "tsv"]);
    const doc = "```tsv\nbody\n```\n\ntrailing\n";
    expect(rendered(doc, [multi], doc.length - 2)[0]?.language).toBe("tsv");
  });

  it("leaves unregistered languages as plain code", () => {
    const doc = "```rust\nfn main() {}\n```\n\ntrailing\n";
    expect(rendered(doc, [alpha], doc.length - 2)).toEqual([]);
  });

  it("reveals the source while the cursor is inside the block", () => {
    const doc = "```alpha\nbody\n```\n";
    expect(countRanges(stateWith(doc, [alpha], 0).field(blockRenderersField).deco)).toBe(0);
  });

  it("renders several registered languages in one document", () => {
    const beta = textRenderer("b", ["beta"]);
    const doc = "```alpha\none\n```\n\n```beta\ntwo\n```\n\ntrailing\n";
    expect(rendered(doc, [alpha, beta], doc.length - 2).map((n) => n.renderer)).toEqual([
      "a",
      "b",
    ]);
  });

  it("skips a renderer whose active() is false", () => {
    const off = textRenderer("off", ["alpha"], { active: () => false });
    const doc = "```alpha\nbody\n```\n\ntrailing\n";
    expect(rendered(doc, [off], doc.length - 2)).toEqual([]);
  });

  it("gives an earlier registration priority for a contested language", () => {
    const second = textRenderer("second", ["alpha"]);
    const doc = "```alpha\nbody\n```\n\ntrailing\n";
    expect(rendered(doc, [alpha, second], doc.length - 2)[0]?.renderer).toBe("a");
  });

  it("rebuilds when a renderer's revision changes", () => {
    let revision = 0;
    const volatile = textRenderer("v", ["alpha"], {
      revision: () => revision,
    });
    const doc = "```alpha\nbody\n```\n\ntrailing\n";
    const view = new EditorView({
      state: stateWith(doc, [volatile], doc.length - 2),
    });
    const first = view.state.field(blockRenderersField);

    revision = 1;
    view.dispatch({ selection: { anchor: doc.length - 3 } });
    const second = view.state.field(blockRenderersField);
    view.destroy();

    expect(second).not.toBe(first);
    expect(second.revisions).toEqual([1]);
  });

  it("keeps the rest of the document rendering when a renderer throws", () => {
    const boom = textRenderer("boom", ["boom"], {
      render: () => {
        throw new Error("renderer exploded");
      },
    });
    const doc = "```boom\nx\n```\n\n```alpha\nbody\n```\n\ntrailing\n";
    const view = new EditorView({
      state: stateWith(doc, [boom, alpha], doc.length - 2),
    });
    const failed = [...view.dom.querySelectorAll(".cm-render-failed")];
    const survived = [...view.dom.querySelectorAll("[data-renderer]")];
    view.destroy();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.textContent).toContain("renderer exploded");
    expect(survived.map((n) => (n as HTMLElement).dataset.renderer)).toEqual([
      "a",
    ]);
  });
});
