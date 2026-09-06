import { describe, expect, it, vi } from "vitest";

import {
  createPathForTarget,
  handleWikiLinkClick,
  type WikiLinkClickResult,
} from "./wikilinkClick";
import type { WikiLinkResolver, WikiLinkResolution } from "./wikilinkResolver";

function resolverWith(
  entries: Record<string, WikiLinkResolution | undefined>,
): WikiLinkResolver {
  return {
    get: (k) => entries[k],
    fetch: () => {},
    resolve: (k) => {
      const hit = entries[k];
      return hit === undefined
        ? Promise.reject(new Error(`no entry for ${k}`))
        : Promise.resolve(hit);
    },
    invalidate: () => {},
    markStale: () => {},
    onUpdate: () => () => {},
    debug: () => ({
      cacheSize: 0,
      inFlight: [],
      lastFetchAt: new Map(),
      lastSettleAt: new Map(),
      lastError: new Map(),
    }),
    onEvent: () => () => undefined,
    abort: () => undefined,
  };
}

describe("createPathForTarget", () => {
  it("appends .md when missing", () => {
    expect(createPathForTarget("Note")).toBe("Note.md");
  });

  it("keeps .md when present", () => {
    expect(createPathForTarget("Note.md")).toBe("Note.md");
  });

  it("preserves slashes as path separators", () => {
    expect(createPathForTarget("notes/sub/Idea")).toBe("notes/sub/Idea.md");
  });

  it("treats the bare target as vault-root relative", () => {
    expect(createPathForTarget("Idea")).toBe("Idea.md");
  });

  it("strips a trailing #anchor before computing the path", () => {
    expect(createPathForTarget("Note#heading")).toBe("Note.md");
    expect(createPathForTarget("Note#^id")).toBe("Note.md");
  });
});

describe("handleWikiLinkClick", () => {
  it("navigates when the target resolves", async () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result: WikiLinkClickResult = await handleWikiLinkClick("note", {
      resolver: resolverWith({
        note: { target_path: "note.md", anchor: null },
      }),
      onNavigate,
      onOfferCreate,
    });
    expect(result).toBe("navigated");
    expect(onNavigate).toHaveBeenCalledWith("note.md", null);
    expect(onOfferCreate).not.toHaveBeenCalled();
  });

  it("offers create when the target is known-unresolved", async () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result = await handleWikiLinkClick("Missing", {
      resolver: resolverWith({
        Missing: { target_path: null, anchor: null },
      }),
      onNavigate,
      onOfferCreate,
    });
    expect(result).toBe("offered");
    expect(onOfferCreate).toHaveBeenCalledWith("Missing.md");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("awaits the fetch and navigates once the resolver settles", async () => {
    let resolveLate: (v: WikiLinkResolution) => void = () => {};
    const lateFetch = new Promise<WikiLinkResolution>((r) => {
      resolveLate = r;
    });
    const resolver: WikiLinkResolver = {
      get: () => undefined,
      fetch: vi.fn(),
      resolve: () => lateFetch,
      invalidate: () => {},
      markStale: () => {},
      onUpdate: () => () => {},
      debug: () => ({
        cacheSize: 0,
        inFlight: [],
        lastFetchAt: new Map(),
        lastSettleAt: new Map(),
        lastError: new Map(),
      }),
      onEvent: () => () => undefined,
      abort: () => undefined,
    };
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const pending = handleWikiLinkClick("note", {
      resolver,
      onNavigate,
      onOfferCreate,
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onOfferCreate).not.toHaveBeenCalled();
    resolveLate({ target_path: "note.md", anchor: null });
    const result = await pending;
    expect(result).toBe("navigated");
    expect(onNavigate).toHaveBeenCalledWith("note.md", null);
  });

  it("echoes the anchor through to onNavigate", async () => {
    const onNavigate = vi.fn();
    const result = await handleWikiLinkClick("note#Heading One", {
      resolver: resolverWith({
        "note#Heading One": {
          target_path: "note.md",
          anchor: { kind: "heading", value: "Heading One" },
        },
      }),
      onNavigate,
      onOfferCreate: vi.fn(),
    });
    expect(result).toBe("navigated");
    expect(onNavigate).toHaveBeenCalledWith("note.md", {
      kind: "heading",
      value: "Heading One",
    });
  });
});
