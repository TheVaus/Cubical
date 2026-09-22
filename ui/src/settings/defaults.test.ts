import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS_DEFAULTS } from "./defaults";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/cubical-engine/tests/fixtures/setting_defaults.json",
);

const shared: Record<string, unknown> = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("defaults the engine also reads agree with cubical-engine", () => {
  it("rewrites broken links on rename by the same default as rename.rs", () => {
    expect(SETTINGS_DEFAULTS.rewriteBrokenLinks).toBe(
      shared["wikilinks.rewrite_broken_links_on_rename"],
    );
  });
});
