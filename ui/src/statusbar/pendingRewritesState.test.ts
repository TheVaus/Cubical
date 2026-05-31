import { describe, expect, it } from "vitest";

import type {
  PendingRewriteBreakdownRow,
  RecentRenameOp,
} from "../api/ipc";
import {
  breakdownKey,
  renameOpKey,
  reducePendingRewritesPopover,
  type PendingRewritesPopoverState,
} from "./pendingRewritesState";

const row = (target_file: string, count: number): PendingRewriteBreakdownRow => ({
  target_file,
  count,
});

const op = (rename_op_id: number, row_count = 1): RecentRenameOp => ({
  rename_op_id,
  kind: "wiki_link",
  row_count,
  created_at: 1_700_000_000 + rename_op_id,
});

describe("reducePendingRewritesPopover", () => {
  const closed: PendingRewritesPopoverState = { kind: "closed" };

  it("starts loading on open", () => {
    expect(reducePendingRewritesPopover(closed, { type: "open" })).toEqual({
      kind: "loading",
    });
  });

  it("transitions loading -> loaded on success", () => {
    const next = reducePendingRewritesPopover(
      { kind: "loading" },
      {
        type: "fetch:success",
        breakdown: [row("Project.md", 2)],
        ops: [op(1)],
      },
    );
    expect(next).toEqual({
      kind: "loaded",
      breakdown: [row("Project.md", 2)],
      ops: [op(1)],
    });
  });

  it("accepts an empty success result", () => {
    const next = reducePendingRewritesPopover(
      { kind: "loading" },
      { type: "fetch:success", breakdown: [], ops: [] },
    );
    expect(next).toEqual({ kind: "loaded", breakdown: [], ops: [] });
  });

  it("captures errors", () => {
    const next = reducePendingRewritesPopover(
      { kind: "loading" },
      { type: "fetch:error", message: "Vault closed" },
    );
    expect(next).toEqual({ kind: "error", message: "Vault closed" });
  });

  it("returns to closed on close", () => {
    const loaded: PendingRewritesPopoverState = {
      kind: "loaded",
      breakdown: [],
      ops: [],
    };
    expect(reducePendingRewritesPopover(loaded, { type: "close" })).toEqual({
      kind: "closed",
    });
  });

  it("re-open while loaded refetches via loading", () => {
    const loaded: PendingRewritesPopoverState = {
      kind: "loaded",
      breakdown: [row("a.md", 1)],
      ops: [op(1)],
    };
    expect(reducePendingRewritesPopover(loaded, { type: "open" })).toEqual({
      kind: "loading",
    });
  });
});

describe("renameOpKey / breakdownKey", () => {
  it("renameOpKey is unique per op id", () => {
    expect(renameOpKey(op(3))).toBe("op-3");
    expect(renameOpKey(op(3))).not.toBe(renameOpKey(op(4)));
  });

  it("breakdownKey is unique per target file", () => {
    expect(breakdownKey(row("a.md", 1))).toBe("bd-a.md");
    expect(breakdownKey(row("a.md", 1))).not.toBe(breakdownKey(row("b.md", 1)));
  });
});
