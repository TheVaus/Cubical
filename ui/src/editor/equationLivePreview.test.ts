// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { wikilinkExtension } from "./wikilink";
import { livePreviewFor } from "./livePreview";
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
    onUpdate: () => () => undefined,
    version: () => 0,
  };
}

const ALL_ON = { math: true, equations: true, propertyRefs: true };

function mount(
  doc: string,
  plugins = ALL_ON,
  rawSource = false,
  resolver: PropertyResolver | null = null,
): EditorView {
  const host = document.createElement("div");
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
        livePreviewFor(rawSource, plugins),
      ],
    }),
  });
}

describe("equations inside the full live-preview bundle", () => {
  it("renders an equation even though InlineCode is also decorated as code", () => {
    const view = mount("intro\n\nShe was `= 5-3` years old.\n");
    expect(
      view.contentDOM.querySelector(".cm-equation")?.textContent,
    ).toBe("2");
    view.destroy();
  });

  it("renders a calc fence through the block renderer registry", () => {
    const view = mount("intro\n\n```calc\n5-3\n```\n");
    expect(view.dom.querySelectorAll(".cm-calc__result")).toHaveLength(1);
    view.destroy();
  });

  it("leaves equations as source in raw mode", () => {
    const view = mount("intro\n\nShe was `= 5-3` old.\n", ALL_ON, true);
    expect(view.contentDOM.querySelector(".cm-equation")).toBeNull();
    view.destroy();
  });

  it("still renders property refs after the compartment was folded in", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: 2019 },
    });
    const view = mount(
      "intro\n\nAge: [[Gandalf.age]].\n",
      ALL_ON,
      false,
      resolver,
    );
    expect(
      view.contentDOM.querySelector(".cm-md-propref")?.textContent,
    ).toBe("2019");
    view.destroy();
  });

  it("honours property-refs being switched off", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: 2019 },
    });
    const view = mount(
      "intro\n\nAge: [[Gandalf.age]].\n",
      { ...ALL_ON, propertyRefs: false },
      false,
      resolver,
    );
    expect(view.contentDOM.querySelector(".cm-md-propref")).toBeNull();
    view.destroy();
  });

  it("leaves equations alone when only math is on", () => {
    const view = mount("intro\n\nShe was `= 5-3` old.\n", {
      ...ALL_ON,
      equations: false,
    });
    expect(view.contentDOM.querySelector(".cm-equation")).toBeNull();
    view.destroy();
  });

  it("keeps math rendering when equations is off", () => {
    const view = mount("intro\n\n$$E = mc^2$$\n", {
      ...ALL_ON,
      equations: false,
    });
    expect(view.dom.querySelector(".cm-math")).not.toBeNull();
    view.destroy();
  });
});
