import { describe, expect, it } from "vitest";

import { canUndoTagRename, undoResultMessage } from "./tagRenameUndo";

describe("canUndoTagRename", () => {
  it("offers undo when the rename minted an op", () => {
    expect(canUndoTagRename(7)).toBe(true);
  });

  it("offers nothing when the rename had no referrers", () => {
    expect(canUndoTagRename(0)).toBe(false);
  });
});

describe("undoResultMessage", () => {
  it("says what was dropped", () => {
    expect(undoResultMessage(3)).toBe("Undone — 3 pending rewrites dropped.");
  });

  it("agrees with a single rewrite", () => {
    expect(undoResultMessage(1)).toBe("Undone — 1 pending rewrite dropped.");
  });

  it("says so rather than claiming success when the flush already ran", () => {
    expect(undoResultMessage(0)).toBe(
      "Nothing to undo — the rewrites have already been applied.",
    );
  });
});
