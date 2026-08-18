// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";

import {
  blockRenderers,
  type BlockRenderer,
} from "./blockRenderers";
import {
  blockCompletions,
  detectFenceTrigger,
  fenceCompletionSource,
} from "./fenceComplete";
import { csvBlockRenderer } from "./csvBlock";
import { mathBlockRenderer, mathEnabledFacet } from "./math";
import { dataviewBlockRenderer, dataviewRunnerFacet } from "./dataview";

describe("detectFenceTrigger", () => {
  it("fires on a bare backtick fence", () => {
    expect(detectFenceTrigger("```", 3)).toEqual({ query: "", from: 3 });
  });

  it("fires on a tilde fence", () => {
    expect(detectFenceTrigger("~~~", 3)).toEqual({ query: "", from: 3 });
  });

  it("carries a partly typed language", () => {
    expect(detectFenceTrigger("```cs", 5)).toEqual({ query: "cs", from: 3 });
  });

  it("keeps the fence's indentation out of the query", () => {
    expect(detectFenceTrigger("  ```ma", 7)).toEqual({ query: "ma", from: 5 });
  });

  it("ignores fences that are not the whole line so far", () => {
    expect(detectFenceTrigger("text ```", 8)).toBeNull();
    expect(detectFenceTrigger("``", 2)).toBeNull();
  });

  it("stops once the info string is settled", () => {
    expect(detectFenceTrigger("```csv ", 7)).toBeNull();
  });
});

describe("blockCompletions", () => {
  const withCompletions: BlockRenderer = {
    id: "demo",
    languages: ["a", "b"],
    frameClass: "",
    completions: [{ language: "a", detail: "Alpha", aliases: ["b"] }],
    render: () => document.createElement("div"),
  };

  const withoutCompletions: BlockRenderer = {
    id: "plain",
    languages: ["x", "y"],
    frameClass: "",
    render: () => document.createElement("div"),
  };

  it("collapses aliases into the entry that declares them", () => {
    expect(blockCompletions([withCompletions])).toEqual([
      { language: "a", detail: "Alpha", aliases: ["b"] },
    ]);
  });

  it("falls back to one entry per language when a renderer declares none", () => {
    expect(blockCompletions([withoutCompletions])).toEqual([
      { language: "x", detail: "plain", aliases: [] },
      { language: "y", detail: "plain", aliases: [] },
    ]);
  });

  it("keeps the first entry when two renderers claim a language", () => {
    const shadow: BlockRenderer = { ...withoutCompletions, id: "shadow" };
    const out = blockCompletions([withoutCompletions, shadow]);
    expect(out.map((o) => o.language)).toEqual(["x", "y"]);
  });
});

function optionsFor(
  doc: string,
  at: number,
  extensions: readonly unknown[] = [],
): { label: string; detail: string | undefined }[] | null {
  const state = EditorState.create({
    doc,
    selection: { anchor: at },
    extensions: [
      markdown(),
      blockRenderers(dataviewBlockRenderer, csvBlockRenderer, mathBlockRenderer),
      ...(extensions as never[]),
    ],
  });
  const result = fenceCompletionSource(new CompletionContext(state, at, false));
  if (result === null) return null;
  return result.options.map((o) => ({ label: o.label, detail: o.detail }));
}

const MATH_ON = mathEnabledFacet.of(true);
const MATH_OFF = mathEnabledFacet.of(false);
const RUNNER = dataviewRunnerFacet.of({
  get: () => undefined,
  fetch: () => {},
  invalidate: () => {},
  onUpdate: () => () => {},
  version: () => 0,
  open: () => {},
});

describe("fenceCompletionSource", () => {
  it("offers every enabled block on a bare fence", () => {
    const opts = optionsFor("```", 3, [MATH_ON, RUNNER]);
    expect(opts?.map((o) => o.label)).toEqual([
      "query",
      "csv",
      "tsv",
      "math",
    ]);
  });

  it("labels each entry with something human", () => {
    const opts = optionsFor("```", 3, [MATH_ON, RUNNER]);
    expect(opts?.find((o) => o.label === "csv")?.detail).toBe("Table");
  });

  it("drops math when math is switched off", () => {
    const opts = optionsFor("```", 3, [MATH_OFF, RUNNER]);
    expect(opts?.map((o) => o.label)).not.toContain("math");
  });

  it("drops the dataview block when no runner is wired", () => {
    const opts = optionsFor("```", 3, [MATH_ON]);
    expect(opts?.map((o) => o.label)).not.toContain("query");
  });

  it("narrows to what has been typed", () => {
    const opts = optionsFor("```cs", 5, [MATH_ON, RUNNER]);
    expect(opts?.map((o) => o.label)).toEqual(["csv"]);
  });

  it("finds a block through an alias it does not display", () => {
    const opts = optionsFor("```kat", 6, [MATH_ON, RUNNER]);
    expect(opts?.map((o) => o.label)).toEqual(["math"]);
  });

  it("stays quiet on a closing fence", () => {
    expect(optionsFor("```csv\na,b\n```", 14, [MATH_ON, RUNNER])).toBeNull();
  });

  it("stays quiet when nothing matches", () => {
    expect(optionsFor("```zzz", 6, [MATH_ON, RUNNER])).toBeNull();
  });

  it("stays quiet mid-line", () => {
    expect(optionsFor("```rust", 3, [MATH_ON, RUNNER])).toBeNull();
  });
});
