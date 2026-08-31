import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";

import {
  pruneContents,
  remapContentKeys,
  staleContentIds,
} from "./contentCache";

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

describe("remapContentKeys", () => {
  it("moves an entry to its renamed id", () => {
    createRoot((dispose) => {
      const [contents, setContents] = createStore<Record<string, string>>({
        "file:Daily.md": "body",
        "file:Other.md": "other",
      });
      remapContentKeys(setContents, contents, (id) =>
        id === "file:Daily.md" ? "file:Journal.md" : id,
      );
      expect(contents).toEqual({
        "file:Journal.md": "body",
        "file:Other.md": "other",
      });
      dispose();
    });
  });

  it("keeps the existing entry when the destination is already open", () => {
    createRoot((dispose) => {
      const [contents, setContents] = createStore<Record<string, string>>({
        a: "moved",
        b: "already there",
      });
      remapContentKeys(setContents, contents, (id) => (id === "a" ? "b" : id));
      expect(contents).toEqual({ b: "already there" });
      dispose();
    });
  });

  it("does not write to the store when no id changes", () => {
    const set = vi.fn();
    remapContentKeys(set, { a: "1" }, (id) => id);
    expect(set).not.toHaveBeenCalled();
  });
});
