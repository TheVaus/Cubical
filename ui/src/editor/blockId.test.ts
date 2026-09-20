import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import { parser } from "@lezer/markdown";

import { findBlockDefinitionOffset } from "./anchorScroll";
import { isBlockId, TRAILING_BLOCK_ID } from "./blockId";
import { findBlockIds } from "./decorations";

interface IdCase {
  id: string;
  valid: boolean;
}

interface LineCase {
  line: string;
  id: string | null;
}

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/cubical-core/tests/fixtures/block_ids.json",
);

const fixture: { ids: IdCase[]; lines: LineCase[] } = JSON.parse(
  readFileSync(FIXTURE, "utf8"),
);
const away = { head: 0, from: 0, to: 0 };

describe("block-ID grammar agrees with cubical_core::vault::blocks", () => {
  for (const c of fixture.ids) {
    it(`${JSON.stringify(c.id)} is ${c.valid ? "valid" : "invalid"}`, () => {
      const src = `x\ntext ^${c.id}`;
      expect(isBlockId(c.id)).toBe(c.valid);
      expect(findBlockIds(Text.of(src.split("\n")), parser.parse(src), away).length > 0).toBe(
        c.valid,
      );
      expect(findBlockDefinitionOffset(src, c.id) !== null).toBe(c.valid);
    });
  }
});

describe("trailing block-ID position agrees with block_id_at_line_end", () => {
  for (const c of fixture.lines) {
    it(`${JSON.stringify(c.line)} yields ${JSON.stringify(c.id)}`, () => {
      expect(TRAILING_BLOCK_ID.exec(c.line)?.[2] ?? null).toBe(c.id);
    });
  }
});
