import { describe, expect, it } from "vitest";

import type { BrokenBlockRef } from "../api/ipc";
import { formatBrokenBlockRefs } from "./brokenRefs";

const ref = (
  source_file_path: string,
  target_file_path: string,
  target_block_id: string,
): BrokenBlockRef => ({
  source_file_path,
  target_file_path,
  target_block_id,
});

describe("formatBrokenBlockRefs", () => {
  it("returns null when there are no broken refs", () => {
    expect(formatBrokenBlockRefs([])).toBeNull();
  });

  it("uses the singular noun for exactly one", () => {
    const d = formatBrokenBlockRefs([ref("a.md", "b.md", "x")]);
    expect(d?.label).toBe("⚠ 1 broken block ref");
    expect(d?.title).toBe("a.md → b.md#^x");
  });

  it("uses the plural noun and one tooltip line per ref", () => {
    const d = formatBrokenBlockRefs([
      ref("a.md", "b.md", "x"),
      ref("c.md", "b.md", "y"),
    ]);
    expect(d?.label).toBe("⚠ 2 broken block refs");
    expect(d?.title).toBe("a.md → b.md#^x\nc.md → b.md#^y");
  });
});
