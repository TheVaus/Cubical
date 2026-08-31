// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { blockRenderers, blockRenderersField } from "./blockRenderers";
import { calcBlockRenderer, renderCalcBlock } from "./calcBlock";
import { equationsEnabledFacet } from "./equation";
import { propertyResolverFacet } from "./propertyRef";
import type { PropertyResolver } from "./propertyResolver";
import type { GetPropertyResponse } from "../api/ipc";

function stubResolver(
  entries: Record<string, GetPropertyResponse>,
): PropertyResolver {
  return {
    get: (note, property) => entries[`${note} ${property}`],
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
    invalidate: () => undefined,
    markStale: () => undefined,
    onUpdate: () => () => undefined,
    version: () => 0,
  };
}

function frames(doc: string, enabled = true): HTMLElement[] {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown(),
        equationsEnabledFacet.of(enabled),
        propertyResolverFacet.of(null),
        blockRenderersField,
        blockRenderers(calcBlockRenderer),
      ],
    }),
  });
  const nodes = [...view.dom.querySelectorAll(".cm-calc")] as HTMLElement[];
  view.destroy();
  return nodes;
}

function results(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".cm-calc__result")].map(
    (n) => n.textContent ?? "",
  );
}

describe("calcBlockRenderer", () => {
  it("renders one result per expression line", () => {
    const state = EditorState.create({
      extensions: [propertyResolverFacet.of(null)],
    });
    const el = renderCalcBlock("5-3\n1200 * 1.2", state);
    expect(results(el)).toEqual(["2", "1440"]);
  });

  it("shows the expression beside its result", () => {
    const state = EditorState.create({
      extensions: [propertyResolverFacet.of(null)],
    });
    const el = renderCalcBlock("5-3", state);
    const source = el.querySelector(".cm-calc__source");
    expect(source?.textContent).toBe("5-3");
  });

  it("keeps evaluating later lines after one fails", () => {
    const state = EditorState.create({
      extensions: [propertyResolverFacet.of(null)],
    });
    const el = renderCalcBlock("5 +\n2 * 3", state);
    expect(results(el)[1]).toBe("6");
  });

  it("skips blank lines", () => {
    const state = EditorState.create({
      extensions: [propertyResolverFacet.of(null)],
    });
    const el = renderCalcBlock("5-3\n\n\n1+1", state);
    expect(results(el)).toEqual(["2", "2"]);
  });

  it("resolves property refs through the resolver", () => {
    const state = EditorState.create({
      extensions: [
        propertyResolverFacet.of(
          stubResolver({ "dan age": { kind: "resolved", value: 5 } }),
        ),
      ],
    });
    const el = renderCalcBlock("[[dan.age]] - 3", state);
    expect(results(el)).toEqual(["2"]);
  });

  it("renders a calc fence in a real document", () => {
    expect(frames("intro\n\n```calc\n5-3\n```\n")).toHaveLength(1);
  });

  it("renders nothing when the plugin is off", () => {
    expect(frames("intro\n\n```calc\n5-3\n```\n", false)).toHaveLength(0);
  });
});
