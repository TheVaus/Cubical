import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blockIdAtLineEnd, isBlockId } from "./blockId";

interface Fixtures {
  ids: { name: string; id: string; valid: boolean }[];
  lines: { name: string; line: string; id: string | null }[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(
  __dirname,
  "../../../crates/cubical-core/tests/fixtures/block-ids.json",
);

const fixtures: Fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

describe("block-id grammar parity with cubical_core::is_valid_block_id", () => {
  for (const c of fixtures.ids) {
    it(c.name, () => {
      expect(isBlockId(c.id)).toBe(c.valid);
    });
  }
});

describe("trailing block-id parity with cubical_core::block_id_at_line_end", () => {
  for (const c of fixtures.lines) {
    it(c.name, () => {
      expect(blockIdAtLineEnd(c.line)).toBe(c.id);
    });
  }
});
