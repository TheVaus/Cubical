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
    invalidate: () => {},
    onUpdate: () => () => {},
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
  it("navigates when the target resolves", () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result: WikiLinkClickResult = handleWikiLinkClick("note", {
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

  it("offers create when the target is known-unresolved", () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result = handleWikiLinkClick("Missing", {
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

  it("returns 'pending' and kicks the fetch when the cache is cold", () => {
    const fetch = vi.fn();
    const resolver: WikiLinkResolver = {
      get: () => undefined,
      fetch,
      invalidate: () => {},
      onUpdate: () => () => {},
    };
    const result = handleWikiLinkClick("note", {
      resolver,
      onNavigate: vi.fn(),
      onOfferCreate: vi.fn(),
    });
    expect(result).toBe("pending");
    expect(fetch).toHaveBeenCalledWith("note");
  });

  it("echoes the anchor through to onNavigate", () => {
    const onNavigate = vi.fn();
    const result = handleWikiLinkClick("note#Heading One", {
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
