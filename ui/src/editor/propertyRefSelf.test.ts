import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("../ast/frontmatter", async (importActual) => {
  const actual = await importActual<typeof import("../ast/frontmatter")>();
  return {
    ...actual,
    parseFrontmatterYaml: (...args: Parameters<typeof actual.parseFrontmatterYaml>) => {
      parses.count++;
      return actual.parseFrontmatterYaml(...args);
    },
  };
});

import { wikilinkExtension } from "./wikilink";
import { buildPropertyDecorations, propertyResolverFacet } from "./propertyRef";

describe("property-ref self references", () => {
  it("parse the note's frontmatter once however many there are", () => {
    const state = EditorState.create({
      doc: "---\nage: 2019\nrole: wizard\n---\n\n[[.age]] [[.role]] [[.age]]\n\ntail\n",
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        propertyResolverFacet.of(null),
      ],
      selection: { anchor: 0 },
    });
    parses.count = 0;
    let rendered = 0;
    buildPropertyDecorations(state).between(0, state.doc.length, () => {
      rendered++;
    });
    expect(rendered).toBe(3);
    expect(parses.count).toBe(1);
  });
});
