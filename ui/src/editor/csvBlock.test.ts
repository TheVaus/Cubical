// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { markdown } from "@codemirror/lang-markdown";
import { csvBlockField, delimiterForInfo } from "./csvBlock";

function stateWith(doc: string, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown(), csvBlockField],
  });
}

function renderedTables(doc: string, cursor = 0): HTMLElement[] {
  const view = new EditorView({ state: stateWith(doc, cursor) });
  const tables = [...view.dom.querySelectorAll(".cm-csv-frame table")];
  view.destroy();
  return tables as HTMLElement[];
}

describe("delimiterForInfo", () => {
  it("maps csv and tsv, case- and space-insensitively", () => {
    expect(delimiterForInfo("csv")).toBe(",");
    expect(delimiterForInfo("  CSV  ")).toBe(",");
    expect(delimiterForInfo("tsv")).toBe("\t");
  });

  it("ignores other languages so code blocks stay code", () => {
    for (const info of ["js", "rust", "query", "", "csvx"]) {
      expect(delimiterForInfo(info)).toBeUndefined();
    }
  });
});

describe("csvBlockField", () => {
  it("renders a csv fenced block as a table", () => {
    const doc = "before\n\n```csv\nname,role\nGandalf,Wizard\n```\n\nafter\n";
    const tables = renderedTables(doc, 0);
    expect(tables).toHaveLength(1);

    const headers = [...tables[0]!.querySelectorAll("th")].map(
      (c) => c.textContent,
    );
    expect(headers).toEqual(["name", "role"]);
    const cells = [...tables[0]!.querySelectorAll("td")].map(
      (c) => c.textContent,
    );
    expect(cells).toEqual(["Gandalf", "Wizard"]);
  });

  it("honours quoted fields containing the delimiter", () => {
    const doc = '```csv\na,b\n"x,y",z\n```\n\ntrailing\n';
    const tables = renderedTables(doc, doc.length - 2);
    const cells = [...tables[0]!.querySelectorAll("td")].map(
      (c) => c.textContent,
    );
    expect(cells).toEqual(["x,y", "z"]);
  });

  it("leaves non-csv code blocks alone", () => {
    const doc = "```js\nconst a = 1;\n```\n";
    expect(renderedTables(doc, 0)).toHaveLength(0);
  });

  it("reveals the source when the cursor is inside the block", () => {
    const doc = "```csv\nname,role\nGandalf,Wizard\n```\n";
    expect(renderedTables(doc, 0)).toHaveLength(0);
  });

  it("renders again once the cursor leaves the block", () => {
    const doc = "```csv\na,b\n1,2\n```\n\ntrailing paragraph\n";
    expect(renderedTables(doc, doc.length - 2)).toHaveLength(1);
  });

  it("renders a tsv block on tabs", () => {
    const doc = "```tsv\na,one\tb\n1\t2\n```\n\ntrailing\n";
    const tables = renderedTables(doc, doc.length - 2);
    const headers = [...tables[0]!.querySelectorAll("th")].map(
      (c) => c.textContent,
    );
    expect(headers).toEqual(["a,one", "b"]);
  });
});
