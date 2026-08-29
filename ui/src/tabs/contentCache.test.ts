import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";

import { pruneContents, staleContentIds } from "./contentCache";

describe("staleContentIds", () => {
  it("names every entry the keep predicate rejects", () => {
    const cached = { a: "1", b: "2", c: "3" };
    expect(staleContentIds(cached, (id) => id === "b")).toEqual(["a", "c"]);
  });

  it("names nothing when every entry is kept", () => {
    expect(staleContentIds({ a: "1" }, () => true)).toEqual([]);
  });
});

describe("pruneContents", () => {
  it("drops the rejected entries and keeps the rest", () => {
    createRoot((dispose) => {
      const [contents, setContents] = createStore<Record<string, string>>({
        a: "1",
        b: "2",
      });
      pruneContents(setContents, contents, (id) => id === "b");
      expect(contents).toEqual({ b: "2" });
      dispose();
    });
  });

  it("does not write to the store when nothing is stale", () => {
    const set = vi.fn();
    pruneContents(set, { a: "1" }, () => true);
    expect(set).not.toHaveBeenCalled();
  });
});
