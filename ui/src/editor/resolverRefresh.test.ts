import { describe, it, expect, vi } from "vitest";

import {
  resetResolvers,
  revalidateResolvers,
  type ResolverGroup,
} from "./resolverRefresh";

const spies = () => ({ invalidate: vi.fn(), markStale: vi.fn() });

const group = () => {
  const wikilink = spies();
  const embed = spies();
  const property = spies();
  const dataview = spies();
  return {
    parts: { wikilink, embed, property, dataview },
    group: {
      wikilink,
      embed,
      property,
      dataview,
    } as unknown as ResolverGroup,
  };
};

describe("resetResolvers", () => {
  it("clears every cache in the group", () => {
    const h = group();
    resetResolvers(h.group);
    for (const [name, part] of Object.entries(h.parts)) {
      expect(part.invalidate, `${name} must be cleared`).toHaveBeenCalledTimes(1);
    }
  });

  it("tolerates a group that is not wired up yet", () => {
    expect(() =>
      resetResolvers({
        wikilink: null,
        embed: null,
        property: null,
        dataview: null,
      }),
    ).not.toThrow();
  });
});

describe("revalidateResolvers", () => {
  it("refreshes every cache in the group", () => {
    const h = group();
    revalidateResolvers(h.group);
    expect(h.parts.wikilink.markStale).toHaveBeenCalledTimes(1);
    expect(h.parts.embed.markStale).toHaveBeenCalledTimes(1);
    expect(h.parts.property.markStale).toHaveBeenCalledTimes(1);
    expect(h.parts.dataview.invalidate).toHaveBeenCalledTimes(1);
  });

  it("never clears a cache it could refresh in place", () => {
    const h = group();
    revalidateResolvers(h.group);
    expect(h.parts.wikilink.invalidate).not.toHaveBeenCalled();
    expect(h.parts.embed.invalidate).not.toHaveBeenCalled();
    expect(h.parts.property.invalidate).not.toHaveBeenCalled();
  });

  it("tolerates a group that is not wired up yet", () => {
    expect(() =>
      revalidateResolvers({
        wikilink: null,
        embed: null,
        property: null,
        dataview: null,
      }),
    ).not.toThrow();
  });
});
