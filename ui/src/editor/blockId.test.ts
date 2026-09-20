import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import { parser } from "@lezer/markdown";

import { findBlockDefinitionOffset } from "./anchorScroll";
import { isBlockId } from "./blockId";
import { findBlockIds } from "./decorations";

interface Case {
  id: string;
  valid: boolean;
}

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/cubical-core/tests/fixtures/block_ids.json",
);

const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
const away = { head: 0, from: 0, to: 0 };

describe("block-ID grammar agrees with cubical_core::vault::blocks", () => {
  for (const c of cases) {
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
