/**
 * Smoke tests for the L4-A search IPC wrappers in `./ipc.ts`.
 *
 * These tests pin the on-wire envelope shape — the four search commands
 * pass arguments under a single `req` key, matching the Rust handlers in
 * `crates/cubical-app/src/lib.rs` (parameter name `req: SearchRequest` /
 * `req: SearchVaultRequest`). If a future refactor changes the envelope,
 * these tests fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  search,
  searchIndexStatus,
  searchRebuildIndex,
  searchGetHealth,
  type SearchRequest,
  type SearchVaultRequest,
} from "./ipc";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe("search ipc wrappers", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("forwards search() to the `search` command with `{ req: { vault_id, query } }`", async () => {
    mockInvoke.mockResolvedValueOnce({
      hits: [],
      total_estimated: 0,
      took_ms: 1,
      still_indexing: false,
    });
    const req: SearchRequest = {
      vault_id: "vault-1",
      query: {
        text: "hello",
        limit: 50,
        offset: 0,
        fields: { kind: "default" },
        fuzzy: false,
        sort: "relevance",
      },
    };
    const resp = await search(req);
    expect(resp.hits).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("search", {
      req: {
        vault_id: "vault-1",
        query: {
          text: "hello",
          limit: 50,
          offset: 0,
          fields: { kind: "default" },
          fuzzy: false,
          sort: "relevance",
        },
      },
    });
  });

  it("searchIndexStatus invokes the status command with `{ req: { vault_id } }`", async () => {
    mockInvoke.mockResolvedValueOnce({
      state: "ready",
      indexed_files: 2,
      total_files: 2,
      last_commit_secs: 1717,
    });
    const req: SearchVaultRequest = { vault_id: "vault-1" };
    const s = await searchIndexStatus(req);
    expect(s.state).toBe("ready");
    expect(s.indexed_files).toBe(2);
    expect(s.last_commit_secs).toBe(1717);
    expect(mockInvoke).toHaveBeenCalledWith("search_index_status", {
      req: { vault_id: "vault-1" },
    });
  });

  it("searchRebuildIndex invokes the rebuild command with `{ req: { vault_id } }`", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await searchRebuildIndex({ vault_id: "vault-1" });
    expect(mockInvoke).toHaveBeenCalledWith("search_rebuild_index", {
      req: { vault_id: "vault-1" },
    });
  });

  it("searchGetHealth returns schema_version + segment/doc/disk fields", async () => {
    mockInvoke.mockResolvedValueOnce({
      schema_version: 1,
      segments: 1,
      doc_count: 2,
      disk_bytes: 100,
    });
    const h = await searchGetHealth({ vault_id: "vault-1" });
    expect(h.schema_version).toBe(1);
    expect(h.segments).toBe(1);
    expect(h.doc_count).toBe(2);
    expect(h.disk_bytes).toBe(100);
    expect(mockInvoke).toHaveBeenCalledWith("search_get_health", {
      req: { vault_id: "vault-1" },
    });
  });
});
