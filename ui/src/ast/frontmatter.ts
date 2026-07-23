import { parse as parseYaml } from "yaml";

import type { Frontmatter, FrontmatterEntry } from "./types";

interface Split {
  yaml: string | null;
  body: string;
  bodyOffset: number;
  span: { start: number; end: number } | null;
}

const OPENER = /^---\r?\n/;

export function splitFrontmatter(source: string): Split {
  const opener = OPENER.exec(source);
  if (!opener || opener.index !== 0) {
    return { yaml: null, body: source, bodyOffset: 0, span: null };
  }
  const yamlStart = opener[0].length;

  let lineStart = yamlStart;
  while (lineStart < source.length) {
    const nl = source.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      const yaml = source.slice(yamlStart, lineStart);
      const bodyOffset = nl === -1 ? source.length : nl + 1;
      return {
        yaml,
        body: source.slice(bodyOffset),
        bodyOffset,
        span: { start: 0, end: bodyOffset },
      };
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }

  return { yaml: null, body: source, bodyOffset: 0, span: null };
}

export function parseFrontmatterYaml(
  yaml: string,
  span: { start: number; end: number },
): Frontmatter | null {
  let value: unknown;
  try {
    value = parseYaml(yaml, { strict: true });
  } catch {
    return null;
  }
  if (value == null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries: FrontmatterEntry[] = Object.entries(
    value as Record<string, unknown>,
  ).map(([k, v]) => [k, normalizeJsonValue(v)] as const);
  return { entries, span };
}

function normalizeJsonValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(normalizeJsonValue);
  if (v && typeof v === "object") {
    if (v instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.entries()) {
        out[String(k)] = normalizeJsonValue(val);
      }
      return out;
    }
    if (v instanceof Set) return Array.from(v).map(normalizeJsonValue);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeJsonValue(val);
    }
    return out;
  }
  return v;
}
