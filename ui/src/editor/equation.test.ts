// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { wikilinkExtension } from "./wikilink";
import { equationExtension, equationsEnabledFacet } from "./equation";
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

function makeView(
  doc: string,
  resolver: PropertyResolver | null = null,
  anchor = 0,
  enabled = true,
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
        equationsEnabledFacet.of(enabled),
        equationExtension,
      ],
    }),
  });
}

function text(view: EditorView): string | undefined {
  const el = view.contentDOM.querySelector(".cm-equation");
  return el?.textContent ?? undefined;
}

describe("equationExtension — inline", () => {
  it("replaces a literal expression with its result", () => {
    const view = makeView("intro\n\nShe was `= 5-3` years old.\n");
    expect(text(view)).toBe("2");
    view.destroy();
  });

  it("uses a cross-note property as an operand", () => {
    const resolver = stubResolver({
      "dan age": { kind: "resolved", value: 5 },
    });
    const view = makeView("intro\n\nShe was `= [[dan.age]] - 3`.\n", resolver);
    expect(text(view)).toBe("2");
    view.destroy();
  });

  it("refuses arithmetic on a quoted number", () => {
    const resolver = stubResolver({
      "dan age": { kind: "resolved", value: "5" },
    });
    const view = makeView("intro\n\nShe was `= [[dan.age]] - 3`.\n", resolver);
    expect(text(view)).toContain("not a number");
    view.destroy();
  });

  it("leaves inline code that is not an expression untouched", () => {
    const view = makeView("intro\n\nUse `=SUM(A1:B2)` in a sheet.\n");
    expect(text(view)).toBeUndefined();
    view.destroy();
  });

  it("leaves ordinary inline code untouched", () => {
    const view = makeView("intro\n\nRun `npm test` first.\n");
    expect(text(view)).toBeUndefined();
    view.destroy();
  });

  it("reveals the source when the cursor is on the line", () => {
    const view = makeView("intro\n\nShe was `= 5-3` old.\n", null, 10);
    expect(text(view)).toBeUndefined();
    view.destroy();
  });

  it("renders nothing when the plugin is off", () => {
    const view = makeView("intro\n\nShe was `= 5-3` old.\n", null, 0, false);
    expect(text(view)).toBeUndefined();
    view.destroy();
  });
});
