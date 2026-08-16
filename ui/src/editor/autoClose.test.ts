// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { insertBracket } from "@codemirror/autocomplete";

import {
  autoCloseExtension,
  closingInsert,
  completeFence,
  isClosedBelow,
  isOpenAbove,
  openerAt,
} from "./autoClose";

// closeBrackets() runs off a DOM inputHandler, so drive its pure core directly.
function typeInto(doc: string, at: number, bracket: string): string {
  const state = EditorState.create({
    doc,
    selection: { anchor: at },
    extensions: [markdown(), autoCloseExtension],
  });
  const tr = insertBracket(state, bracket);
  if (tr === null) {
    return doc.slice(0, at) + bracket + doc.slice(at);
  }
  return state.update(tr).state.doc.toString();
}

function enterAt(
  doc: string,
  at: number,
): { handled: boolean; doc: string; head: number } {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [markdown(), autoCloseExtension],
    }),
  });
  const handled = completeFence(view);
  const out = {
    handled,
    doc: view.state.doc.toString(),
    head: view.state.selection.main.head,
  };
  view.destroy();
  return out;
}

describe("openerAt", () => {
  it("recognises a backtick fence with and without an info string", () => {
    expect(openerAt("```")).toEqual({ indent: "", marker: "```" });
    expect(openerAt("```rust")).toEqual({ indent: "", marker: "```" });
    expect(openerAt("  ```csv")).toEqual({ indent: "  ", marker: "```" });
  });

  it("recognises a tilde fence", () => {
    expect(openerAt("~~~")).toEqual({ indent: "", marker: "~~~" });
  });

  it("ignores lines that are not fences", () => {
    expect(openerAt("``")).toBeNull();
    expect(openerAt("text ```")).toBeNull();
    expect(openerAt("")).toBeNull();
  });
});

describe("isClosedBelow", () => {
  const fence = { indent: "", marker: "```" };

  it("sees an existing bare closer", () => {
    expect(isClosedBelow("\nbody\n```\nafter\n", fence)).toBe(true);
  });

  it("treats the next opener as unclosed", () => {
    expect(isClosedBelow("\nbody\n```rust\n", fence)).toBe(false);
  });

  it("reports no closer at end of document", () => {
    expect(isClosedBelow("\nbody\n", fence)).toBe(false);
  });
});

describe("isOpenAbove", () => {
  it("reports nothing open at the top of a document", () => {
    expect(isOpenAbove("")).toBe(false);
    expect(isOpenAbove("prose\n\nmore prose\n")).toBe(false);
  });

  it("sees an opener that nothing has closed yet", () => {
    expect(isOpenAbove("```rust\nbody\n")).toBe(true);
  });

  it("sees a balanced block as closed", () => {
    expect(isOpenAbove("```rust\nbody\n```\n")).toBe(false);
  });

  it("does not let a tilde fence close a backtick fence", () => {
    expect(isOpenAbove("```\nbody\n~~~\n")).toBe(true);
  });

  it("does not let a shorter marker close a longer one", () => {
    expect(isOpenAbove("````\nbody\n```\n")).toBe(true);
    expect(isOpenAbove("````\nbody\n````\n")).toBe(false);
  });

  it("does not let an info string close a block", () => {
    expect(isOpenAbove("```\nbody\n```rust\n")).toBe(true);
  });

  it("tracks a second block after a closed one", () => {
    expect(isOpenAbove("```\na\n```\n\n```js\nb\n")).toBe(true);
  });
});

describe("closingInsert", () => {
  it("keeps the opener's indentation", () => {
    expect(closingInsert({ indent: "  ", marker: "```" })).toBe("\n\n  ```");
  });
});

describe("Enter on a fence opener", () => {
  it("adds a blank line and a closing fence, cursor inside", () => {
    const r = enterAt("```rust", 7);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("```rust\n\n```");
    expect(r.head).toBe(8);
  });

  it("does not add a second closer when one already exists", () => {
    const r = enterAt("```\nbody\n```\n", 3);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe("```\nbody\n```\n");
  });

  it("leaves a closing fence alone", () => {
    const r = enterAt("```rust\nbody\n```", 16);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe("```rust\nbody\n```");
  });

  it("leaves the closer alone on a block it just completed", () => {
    const r = enterAt("```\n\n```", 8);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe("```\n\n```");
  });

  it("still completes an opener below a finished block", () => {
    const r = enterAt("```\na\n```\n\n```js", 16);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe("```\na\n```\n\n```js\n\n```");
  });

  it("stays out of the way mid-line and on ordinary lines", () => {
    expect(enterAt("```rust", 3).handled).toBe(false);
    expect(enterAt("plain text", 10).handled).toBe(false);
  });
});

describe("bracket auto-close", () => {
  it("turns a second [ into a full [[ ]] pair", () => {
    expect(typeInto("", 0, "[")).toBe("[]");
    expect(typeInto("[]", 1, "[")).toBe("[[]]");
  });

  it("closes parens and braces", () => {
    expect(typeInto("", 0, "(")).toBe("()");
    expect(typeInto("", 0, "{")).toBe("{}");
  });

  it("leaves prose apostrophes and quotes alone", () => {
    expect(typeInto("", 0, "'")).toBe("'");
    expect(typeInto("", 0, '"')).toBe('"');
  });
});
