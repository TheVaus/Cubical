/**
 * Canonical Markdown AST — TypeScript mirror of `cubical_ast::Document`.
 *
 * This file is the wire-shape contract for the AST IPC surface. Every
 * field name, tag string, and structural choice mirrors
 * `crates/cubical-ast/src/types.rs`. Both sides serialize through the
 * same JSON, so the canonical AST produced in the editor (via
 * `normalize.ts`) is interchangeable with the canonical AST produced
 * in Rust by `cubical_ast::parse`.
 *
 * The Rust side uses `#[serde(tag = "kind", rename_all = "snake_case")]`
 * on the `Block` and `Inline` enums; the TS mirror is a discriminated
 * union keyed on `kind`, with `snake_case` tag strings.
 *
 * If a field changes here, change it in `types.rs` (and vice versa)
 * in the same commit. The cross-language parity harness in
 * `crates/cubical-ast/tests/fixtures/parity.json` is the load-bearing
 * regression test.
 */

/**
 * Half-open byte range `[start, end)` into the source string.
 *
 * Spans are recorded for block-level nodes only. Inlines do not carry
 * spans in L1; adding inline spans is a deliberate decision for the
 * layer that needs them (likely L2's editor mapping).
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * One YAML frontmatter key/value pair.
 *
 * `value` is whatever JSON shape the source YAML had — scalar, array,
 * or nested object — so callers narrow it themselves.
 */
export type FrontmatterEntry = readonly [key: string, value: unknown];

/**
 * Parsed YAML frontmatter plus the source span (`---` lines included).
 */
export interface Frontmatter {
  entries: FrontmatterEntry[];
  span: Span;
}

/**
 * Top-level parsed document. `source_len` is the byte length of the
 * source string the document was parsed from; consumers can use it
 * to bound-check spans cheaply.
 */
export interface CanonicalDocument {
  frontmatter: Frontmatter | null;
  blocks: Block[];
  source_len: number;
}

/** Block-level AST node. Discriminated on `kind`. */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[]; span: Span }
  | { kind: "paragraph"; inlines: Inline[]; span: Span }
  | { kind: "list"; ordered: boolean; items: ListItem[]; span: Span }
  | { kind: "code_block"; lang: string | null; content: string; span: Span }
  | { kind: "quote"; blocks: Block[]; span: Span }
  | { kind: "thematic_break"; span: Span }
  | { kind: "html"; content: string; span: Span };

/**
 * One item inside a `Block` of `kind: "list"`. Items are sequences
 * of blocks — pulldown-cmark wraps loose-item content in its own
 * paragraphs and tight-item content in a single paragraph; both
 * shapes flow through here.
 */
export interface ListItem {
  blocks: Block[];
  span: Span;
}

/** Inline-level AST node. Discriminated on `kind`. */
export type Inline =
  | { kind: "text"; value: string }
  | { kind: "emph"; children: Inline[] }
  | { kind: "strong"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; dest: string; title: string | null; children: Inline[] }
  | { kind: "image"; dest: string; title: string | null; alt: Inline[] }
  | { kind: "line_break" };
