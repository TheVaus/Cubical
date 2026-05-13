/**
 * YAML frontmatter splitter — TypeScript mirror of
 * `crates/cubical-ast/src/frontmatter.rs`.
 *
 * Detection rules (must match the Rust side byte-for-byte):
 * - Opening `---` lives on the first line at byte 0. No leading
 *   whitespace, no BOM tolerance.
 * - Closing `---` is on its own line (no trailing content).
 * - CRLF line endings are tolerated.
 * - The closing `---` must come *before* any other content; if a
 *   matching closer is never found the source is treated as having
 *   no frontmatter.
 *
 * Note: a code-fence like `` ``` `` containing a literal `---` line
 * does not "shield" a closer because we operate before any markdown
 * parsing — but in practice a true `---` on column 0 inside a code
 * block is the same byte sequence as a frontmatter closer. The Rust
 * side has the same property. The split is intentionally cheap and
 * unambiguous.
 */

import { parse as parseYaml } from "yaml";

import type { Frontmatter, FrontmatterEntry } from "./types";

interface Split {
  /** YAML body between the `---` lines, or `null` if no frontmatter. */
  yaml: string | null;
  /** Markdown body after the closing `---` line. */
  body: string;
  /** Byte offset of `body` within the original source. */
  bodyOffset: number;
  /** Source span of the entire frontmatter block, or `null`. */
  span: { start: number; end: number } | null;
}

const OPENER = /^---\r?\n/;

/**
 * Split `source` into its (optional) YAML frontmatter and the body.
 *
 * Returns `{ yaml: null, body: source, bodyOffset: 0, span: null }`
 * when no valid frontmatter is present.
 */
export function splitFrontmatter(source: string): Split {
  const opener = OPENER.exec(source);
  if (!opener || opener.index !== 0) {
    return { yaml: null, body: source, bodyOffset: 0, span: null };
  }
  const yamlStart = opener[0].length;

  // Scan line-by-line for a closer (`---` followed by line end or EOF).
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

/**
 * Parse a YAML body into `Frontmatter.entries`. Mirrors the Rust
 * side's "must be a mapping at the top level" rule: bare scalars or
 * lists return `null`, and parser errors return `null` (the body is
 * still parsed normally by the caller).
 */
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
    // An empty YAML body parses to `null`; treat as no frontmatter
    // entries but record the span to match the Rust side's behavior
    // for `--- \n ---`-only sources. Rust returns None in this case;
    // mirror that.
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

/**
 * Normalize parsed YAML into the JSON shape `serde_yaml_ng → serde_json`
 * produces. Most types are already JSON-compatible; `undefined` becomes
 * `null`, `Map`/`Set` are flattened (defensive; not produced by the
 * `yaml` package's default settings), and `bigint` (extremely large
 * integer literals) become numbers because `serde_json::Number`
 * deserializes them as JSON numbers.
 */
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
