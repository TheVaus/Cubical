import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({ listTags: vi.fn() }));

import { listTags } from "../api/ipc";
import { createVaultTags } from "./vaultTags";

const list = listTags as unknown as ReturnType<typeof vi.fn>;

const build = () =>
  createRoot(() => {
    const [vault, setVault] = createSignal<string | null>("a");
    return { tags: createVaultTags(vault), setVault };
  });

beforeEach(() => {
  list.mockReset();
  list.mockImplementation(async ({ vault_id }: { vault_id: string }) => ({
    tags: [`${vault_id}-tag`],
  }));
});

describe("vault tags", () => {
  it("loads once per vault", async () => {
    const { tags } = build();
    await tags.ensureLoaded();
    await tags.ensureLoaded();
    expect(tags.tags()).toEqual(["a-tag"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not offer the previous vault's tags after a switch", async () => {
    const { tags, setVault } = build();
    await tags.ensureLoaded();

    setVault("b");
    expect(tags.tags()).toEqual([]);

    await tags.ensureLoaded();
    expect(tags.tags()).toEqual(["b-tag"]);
  });

  it("drops a listing that lands after the vault changed", async () => {
    const { tags, setVault } = build();
    const pending = tags.ensureLoaded();
    setVault("b");
    await pending;
    expect(tags.tags()).toEqual([]);
  });

  it("keeps offering the current tags while an invalidation waits for a reload", async () => {
    const { tags } = build();
    await tags.ensureLoaded();
    tags.invalidate();
    expect(tags.tags()).toEqual(["a-tag"]);
  });

  it("reloads after an invalidation", async () => {
    const { tags } = build();
    await tags.ensureLoaded();
    tags.invalidate();
    await tags.ensureLoaded();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("runs notes-only when the listing fails", async () => {
    const { tags } = build();
    list.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tags.ensureLoaded();
    expect(tags.tags()).toEqual([]);
  });
});
