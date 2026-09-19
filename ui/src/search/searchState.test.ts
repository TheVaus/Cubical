import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchHit, SearchResponse } from "../api/search";
import { createSearchState } from "./searchState";

const hit = (path: string) => ({ path }) as unknown as SearchHit;
const response = (path: string): SearchResponse => ({
  hits: [hit(path)],
  total_estimated: 1,
  took_ms: 1,
  still_indexing: false,
});

interface Pending {
  vault: string;
  resolve: (r: SearchResponse) => void;
}

const build = () => {
  const pending: Pending[] = [];
  const runSearch = vi.fn(
    (req: { vault_id: string }) =>
      new Promise<SearchResponse>((resolve) =>
        pending.push({ vault: req.vault_id, resolve }),
      ),
  );
  const readStatus = vi.fn(async () => ({
    state: "ready" as const,
    indexed_files: 0,
    total_files: 0,
    last_commit_secs: null,
  }));
  let dispose!: () => void;
  const [vault, setVault] = createSignal<string | null>("a");
  const state = createRoot((d) => {
    dispose = d;
    return createSearchState({
      vaultId: vault,
      refreshSignal: () => 0,
      runSearch: runSearch as never,
      readStatus: readStatus as never,
    });
  });
  return { state, pending, runSearch, readStatus, setVault, dispose };
};

const paths = (s: ReturnType<typeof build>["state"]) =>
  s.hits().map((h) => h.path);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("search responses", () => {
  it("keeps the newest query's hits when an older one lands last", async () => {
    const h = build();
    h.state.input("alpha");
    await vi.advanceTimersByTimeAsync(200);
    h.state.chooseSort("recency_desc");

    h.pending[1]!.resolve(response("recent.md"));
    h.pending[0]!.resolve(response("relevance.md"));
    await vi.advanceTimersByTimeAsync(0);

    expect(paths(h.state)).toEqual(["recent.md"]);
    h.dispose();
  });

  it("stays empty after clear even if a query was in flight", async () => {
    const h = build();
    h.state.input("alpha");
    await vi.advanceTimersByTimeAsync(200);
    h.state.clear();

    h.pending[0]!.resolve(response("late.md"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.state.hits()).toEqual([]);
    h.dispose();
  });
});

describe("a vault switch", () => {
  it("drops the previous vault's hits and searches the new vault", async () => {
    const h = build();
    h.state.input("alpha");
    await vi.advanceTimersByTimeAsync(200);
    h.pending[0]!.resolve(response("a.md"));
    await vi.advanceTimersByTimeAsync(0);
    expect(paths(h.state)).toEqual(["a.md"]);

    h.setVault("b");
    expect(h.state.hits()).toEqual([]);
    expect(h.pending.at(-1)?.vault).toBe("b");

    h.pending.at(-1)!.resolve(response("b.md"));
    await vi.advanceTimersByTimeAsync(0);
    expect(paths(h.state)).toEqual(["b.md"]);
    h.dispose();
  });

  it("reads the new vault's index status", async () => {
    const h = build();
    await vi.advanceTimersByTimeAsync(0);
    h.setVault("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readStatus).toHaveBeenLastCalledWith({ vault_id: "b" });
    h.dispose();
  });
});
