import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
      out.push(path);
  }
  return out;
}

function declaredKeys(text: string): string[] {
  const keys: string[] = [];
  for (const head of text.matchAll(/interface SettingRegistry \{/g)) {
    const from = head.index + head[0].length;
    const body = text.slice(from, text.indexOf("}", from));
    for (const key of body.matchAll(/^\s*"([^"]+)"\s*:/gm)) keys.push(key[1]!);
  }
  return keys;
}

const files = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("SettingRegistry has one owner per key", () => {
  it("declares every setting key exactly once across substrate and blocks", () => {
    const owners = new Map<string, string[]>();
    for (const file of files) {
      for (const key of declaredKeys(file.text)) {
        owners.set(key, [...(owners.get(key) ?? []), file.path]);
      }
    }
    expect(owners.size).toBeGreaterThan(0);
    const duplicated = [...owners].filter(([, paths]) => paths.length > 1);
    expect(duplicated).toEqual([]);
  });

  it("declares each registered settingKey in the file that registers it", () => {
    const borrowed: string[] = [];
    for (const file of files) {
      const declared = new Set(declaredKeys(file.text));
      for (const use of file.text.matchAll(/settingKey:\s*"([^"]+)"/g)) {
        if (!declared.has(use[1]!)) borrowed.push(`${file.path}: ${use[1]}`);
      }
    }
    expect(borrowed).toEqual([]);
  });
});
