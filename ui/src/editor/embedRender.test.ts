// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { MAX_EMBED_DEPTH, renderEmbedBody } from "./embedRender";
import type { EmbedResolver, EmbedResolution } from "./embedResolver";

function stubResolver(entries: Record<string, EmbedResolution>): {
  resolver: EmbedResolver;
  fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    resolver: {
      get: (t) => entries[t],
      fetch: (t) => fetched.push(t),
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      markStale: () => undefined,
      onUpdate: () => () => undefined,
      debug: () => ({
        cacheSize: 0,
        inFlight: [],
        lastFetchAt: new Map(),
        lastSettleAt: new Map(),
        lastError: new Map(),
      }),
      onEvent: () => () => undefined,
      abort: () => undefined,
      version: () => 0,
    },
  };
}

describe("renderEmbedBody", () => {
  it("renders a 'Loading…' placeholder and kicks a fetch on cache miss", () => {
    const { resolver, fetched } = stubResolver({});
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily",
      chain: [],
    });
    expect(frag.querySelector(".cm-md-embed-loading")).not.toBeNull();
    expect(fetched).toEqual(["Daily"]);
  });

  it("renders preserved-newline text for a resolved note embed", () => {
    const { resolver } = stubResolver({
      Daily: {
        kind: "note",
        target_path: "Daily.md",
        content: "line 1\nline 2\n",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("line 1\nline 2\n");
  });

  it("renders an unresolved placeholder", () => {
    const { resolver } = stubResolver({
      Ghost: { kind: "unresolved", target_path: null, content: null },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Ghost",
      chain: [],
    });
    const ph = frag.querySelector(".cm-md-embed-placeholder-unresolved");
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toContain("[[Ghost]]");
  });

  it("renders a missing-anchor placeholder", () => {
    const { resolver } = stubResolver({
      "Daily#Ghost": {
        kind: "missing-anchor",
        target_path: "Daily.md",
        content: null,
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#Ghost",
      chain: [],
    });
    const ph = frag.querySelector(".cm-md-embed-placeholder-missing-anchor");
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toContain("[[Daily#Ghost]]");
  });

  it("renders a cycle link when the target_path is already in the chain", () => {
    const { resolver } = stubResolver({
      Self: { kind: "note", target_path: "Self.md", content: "(unused)" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Self",
      chain: ["Self.md"],
    });
    const link = frag.querySelector(".cm-md-embed-link-cycle");
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("![[Self]]");
  });

  it("renders a depth link when chain length reaches the cap", () => {
    const { resolver } = stubResolver({
      Deep: { kind: "note", target_path: "Deep.md", content: "(unused)" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Deep",
      chain: ["a.md", "b.md", "c.md", "d.md"],
    });
    expect(MAX_EMBED_DEPTH).toBe(4);
    const link = frag.querySelector(".cm-md-embed-link-depth");
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("![[Deep]]");
  });

  it("recursively renders nested ![[…]] within content", () => {
    const { resolver, fetched } = stubResolver({
      Outer: {
        kind: "note",
        target_path: "Outer.md",
        content: "before ![[Inner]] after",
      },
      Inner: { kind: "note", target_path: "Inner.md", content: "INNER" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Outer",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body")!;
    expect(body.textContent).toContain("before");
    expect(body.textContent).toContain("after");
    expect(body.textContent).toContain("INNER");
    expect(fetched).toEqual([]);
  });

  it("leaves a non-embed `[[…]]` (no leading `!`) as plain text inside content", () => {
    const { resolver } = stubResolver({
      Outer: {
        kind: "note",
        target_path: "Outer.md",
        content: "see [[Other]] here",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Outer",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body")!;
    expect(body.textContent).toBe("see [[Other]] here");
  });

  it("threads the chain through nested recursion (cycle within content)", () => {
    const { resolver } = stubResolver({
      A: {
        kind: "note",
        target_path: "A.md",
        content: "loop: ![[B]]",
      },
      B: {
        kind: "note",
        target_path: "B.md",
        content: "back: ![[A]]",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "A",
      chain: ["host.md"],
    });
    const cycleLink = frag.querySelector(".cm-md-embed-link-cycle");
    expect(cycleLink).not.toBeNull();
    expect(cycleLink!.textContent).toBe("![[A]]");
  });

  it("renders a section embed body the same way as a note embed body", () => {
    const { resolver } = stubResolver({
      "Daily#Intro": {
        kind: "section",
        target_path: "Daily.md",
        content: "Intro paragraph\n",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#Intro",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("Intro paragraph\n");
  });

  it("renders a block embed body the same way", () => {
    const { resolver } = stubResolver({
      "Daily#^abc123": {
        kind: "block",
        target_path: "Daily.md",
        content: "single block line ^abc123",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#^abc123",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("single block line ^abc123");
  });

  it("renders an embedded image the same way its tab does", () => {
    const png = btoa("\x89PNG\r\n\x1a\n");
    const { resolver } = stubResolver({
      "photo.png": {
        kind: "file",
        target_path: "photo.png",
        content: png,
        mime: "image/png",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "photo.png",
      chain: [],
    });
    const img = frag.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
    expect(frag.textContent).not.toContain("\uFFFD");
  });

  it("renders an embedded csv as a table, not as markdown text", () => {
    const { resolver } = stubResolver({
      "data.csv": {
        kind: "file",
        target_path: "data.csv",
        content: btoa('name,role\nGandalf,"Wizard, grey"\n'),
        mime: "text/csv",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "data.csv",
      chain: [],
    });
    const headers = [...frag.querySelectorAll("th")].map((c) => c.textContent);
    expect(headers).toEqual(["name", "role"]);
    const cells = [...frag.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["Gandalf", "Wizard, grey"]);
  });

  it("renders an embedded txt as plain text", () => {
    const { resolver } = stubResolver({
      "notes.txt": {
        kind: "file",
        target_path: "notes.txt",
        content: btoa("line one\nline two"),
        mime: "text/plain",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "notes.txt",
      chain: [],
    });
    expect(frag.querySelector(".viewer__text")!.textContent).toBe(
      "line one\nline two",
    );
  });

  it("warns rather than rendering when the file was too large to serve", () => {
    const { resolver } = stubResolver({
      "huge.png": {
        kind: "file",
        target_path: "huge.png",
        content: null,
        mime: "image/png",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "huge.png",
      chain: [],
    });
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("too large to embed");
  });
});
