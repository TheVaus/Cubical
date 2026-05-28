import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";

import {
  detectLinkTrigger,
  detectTagTrigger,
  linkInsertion,
  linkCompletionSource,
  tagCompletionSource,
} from "./autocomplete";
import type { AutocompleteProvider } from "./autocompleteProvider";

describe("detectLinkTrigger", () => {
  it("matches an open [[ with an empty query", () => {
    expect(detectLinkTrigger("see [[", 6)).toEqual({ query: "", from: 6 });
  });
  it("captures the partial target", () => {
    expect(detectLinkTrigger("x [[fo", 6)).toEqual({ query: "fo", from: 4 });
  });
  it("returns null once the link is closed", () => {
    expect(detectLinkTrigger("[[a]] ", 6)).toBeNull();
  });
  it("stops at a pipe (display) — no link trigger past it", () => {
    expect(detectLinkTrigger("[[a|", 4)).toBeNull();
  });
  it("stops at a hash (anchor) — no link trigger past it", () => {
    expect(detectLinkTrigger("[[a#", 4)).toBeNull();
  });
  it("returns null without an opener", () => {
    expect(detectLinkTrigger("no brackets here", 16)).toBeNull();
  });
});

describe("detectTagTrigger", () => {
  it("matches a bare # at start of line", () => {
    expect(detectTagTrigger("#", 1)).toEqual({ query: "", from: 1 });
  });
  it("matches # after whitespace with a partial body", () => {
    expect(detectTagTrigger("a #pr", 5)).toEqual({ query: "pr", from: 3 });
  });
  it("captures nested tag bodies", () => {
    expect(detectTagTrigger("#pr/su", 6)).toEqual({ query: "pr/su", from: 1 });
  });
  it("returns null when # is not at a word boundary", () => {
    expect(detectTagTrigger("a#pr", 4)).toBeNull();
  });
});

describe("linkInsertion", () => {
  it("adds the closing ]] when none follows", () => {
    expect(linkInsertion("notes/a.md", false)).toEqual({
      insert: "notes/a.md]]",
      cursorAfter: 12,
    });
  });
  it("omits the closer when ]] already follows the cursor", () => {
    expect(linkInsertion("notes/a.md", true)).toEqual({
      insert: "notes/a.md",
      cursorAfter: 10,
    });
  });
});

// --- Source integration (headless: EditorState + CompletionContext) -------

const fakeProvider = (
  links: { path: string; title: string }[],
  tags: string[],
): AutocompleteProvider => ({
  links: async () => links,
  tags: async () => tags,
});

function ctxAt(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return new CompletionContext(state, pos, false);
}

describe("linkCompletionSource", () => {
  it("returns candidates inside a paragraph", async () => {
    const src = linkCompletionSource(
      fakeProvider([{ path: "a.md", title: "a" }], []),
    );
    const res = await src(ctxAt("see [[a", 7));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(6);
    expect(res!.options.map((o) => o.label)).toContain("a");
  });

  it("is suppressed inside a fenced code block", async () => {
    const src = linkCompletionSource(
      fakeProvider([{ path: "a.md", title: "a" }], []),
    );
    const doc = "```\n[[a\n```\n";
    const res = await src(ctxAt(doc, 6)); // inside the fence, after [[
    expect(res).toBeNull();
  });
});

describe("tagCompletionSource", () => {
  it("returns tag candidates in a paragraph", async () => {
    const src = tagCompletionSource(fakeProvider([], ["project"]));
    const res = await src(ctxAt("#pr", 3));
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label)).toContain("project");
  });

  it("is suppressed inside inline code", async () => {
    const src = tagCompletionSource(fakeProvider([], ["project"]));
    // `#pr` is preceded by a space INSIDE the code span, so trigger
    // detection succeeds (word boundary) and gating is what rejects it.
    const doc = "a `x #pr` b";
    const res = await src(ctxAt(doc, 8)); // caret after `r`, inside InlineCode
    expect(res).toBeNull();
  });
});
