// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { wikilinkExtension } from "./wikilink";
import {
  buildPropertyDecorations,
  propertyRefField,
  propertyRefExtension,
  propertyResolverFacet,
  propertyResolverUpdated,
} from "./propertyRef";
import type { PropertyResolver } from "./propertyResolver";
import type { GetPropertyResponse } from "../api/ipc";

function stubResolver(
  entries: Record<string, GetPropertyResponse>,
  version = 0,
): PropertyResolver {
  return {
    get: (note, property) => entries[`${note} ${property}`],
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
    invalidate: () => undefined,
    onUpdate: () => () => undefined,
    version: () => version,
  };
}

function makeView(
  doc: string,
  resolver: PropertyResolver | null,
  anchor = 0,
): EditorView {
  const host = document.createElement("div");
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
        propertyRefExtension,
      ],
    }),
  });
}

function decoCount(state: EditorState): number {
  let n = 0;
  state.field(propertyRefField).between(0, state.doc.length, () => {
    n++;
  });
  return n;
}

describe("propertyRefExtension", () => {
  it("emits no decoration when the doc has no property ref", () => {
    const state = EditorState.create({
      doc: "plain [[Link]] text\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(stubResolver({})),
        propertyRefField,
      ],
      selection: { anchor: 0 },
    });
    expect(decoCount(state)).toBe(0);
  });

  it("replaces a resolved cross-file ref token", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: "2019" },
    });
    const state = EditorState.create({
      doc: "intro\n\nAge: [[Gandalf.age]].\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
        propertyRefField,
      ],
      selection: { anchor: 0 },
    });
    expect(decoCount(state)).toBe(1);
  });

  it("renders the resolved value in a real view", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: "2019" },
    });
    const view = makeView("intro\n\nAge: [[Gandalf.age]].\n", resolver, 0);
    const span = view.contentDOM.querySelector(".cm-md-propref");
    expect(span?.textContent).toBe("2019");
    expect(span?.className).not.toContain("broken");
    view.destroy();
  });

  it("resolves a self-ref from the open doc's frontmatter", () => {
    const view = makeView(
      "---\nlevel: 5\n---\n\nLevel is [[.level]].\n",
      null,
      0,
    );
    const span = view.contentDOM.querySelector(".cm-md-propref");
    expect(span?.textContent).toBe("5");
    view.destroy();
  });

  it("renders broken-ref styling for a missing cross-file value", () => {
    const resolver = stubResolver({
      "Ghost age": { kind: "note_unresolved", value: null },
    });
    const view = makeView("intro\n\nNope: [[Ghost.age]].\n", resolver, 0);
    const span = view.contentDOM.querySelector(".cm-md-propref-broken");
    expect(span?.textContent).toBe("[[Ghost.age]]");
    view.destroy();
  });

  it("suppresses the decoration when the cursor is on the token's line", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: "2019" },
    });
    const doc = "intro\n\nAge: [[Gandalf.age]].\n";
    const onLine = doc.indexOf("[[Gandalf.age]]") + 2;
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
        propertyRefField,
      ],
      selection: { anchor: onLine },
    });
    expect(decoCount(state)).toBe(0);
  });

  it("rebuilds on propertyResolverUpdated (cold → resolved)", () => {
    const entries: Record<string, GetPropertyResponse> = {};
    let version = 0;
    const resolver: PropertyResolver = {
      get: (note, property) => entries[`${note} ${property}`],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
      version: () => version,
    };
    const view = makeView("intro\n\nAge: [[Gandalf.age]].\n", resolver, 0);
    expect(view.contentDOM.querySelector(".cm-md-propref-loading")).not.toBeNull();

    entries["Gandalf age"] = { kind: "resolved", value: "2019" };
    version++;
    view.dispatch({ effects: propertyResolverUpdated.of(null) });
    const span = view.contentDOM.querySelector(".cm-md-propref");
    expect(span?.textContent).toBe("2019");
    expect(view.contentDOM.querySelector(".cm-md-propref-loading")).toBeNull();
    view.destroy();
  });

  it("exposes buildPropertyDecorations for unit use", () => {
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: "2019" },
    });
    const state = EditorState.create({
      doc: "intro\n\n[[Gandalf.age]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
      ],
      selection: { anchor: 0 },
    });
    let count = 0;
    buildPropertyDecorations(state).between(0, state.doc.length, () => {
      count++;
    });
    expect(count).toBe(1);
  });

  it("does not materialize the whole document when there's no self-ref to resolve", () => {
    // Only a cross-note ref — `selfValue` (which needs the full doc text
    // to find this note's own frontmatter) is never reached.
    const resolver = stubResolver({
      "Gandalf age": { kind: "resolved", value: "2019" },
    });
    const state = EditorState.create({
      doc: "intro\n\n[[Gandalf.age]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(resolver),
      ],
      selection: { anchor: 0 },
    });
    const spy = vi.spyOn(state.doc, "toString");
    buildPropertyDecorations(state);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still resolves a self-ref correctly (materializing the doc lazily)", () => {
    const state = EditorState.create({
      doc: "---\nage: 2019\n---\n\n[[.age]]\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(null),
      ],
      selection: { anchor: 0 },
    });
    let renderedValue: string | undefined;
    buildPropertyDecorations(state).between(0, state.doc.length, (_f, _t, deco) => {
      renderedValue = (deco.spec.widget as unknown as { render: { value?: string } })
        .render.value;
    });
    expect(renderedValue).toBe("2019");
  });
});
