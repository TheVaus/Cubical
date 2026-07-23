import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalize } from "./normalize";

interface Fixture {
  name: string;
  input: string;
  expected: unknown;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_PATH = resolve(
  __dirname,
  "../../../crates/cubical-ast/tests/fixtures/parity.json",
);

const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

describe("AST parity with cubical_ast::parse", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const actual = JSON.parse(JSON.stringify(normalize(f.input)));
      expect(actual).toEqual(f.expected);
    });
  }
});
