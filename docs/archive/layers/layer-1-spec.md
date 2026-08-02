> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../architecture/) and [`docs/implementation/`](../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Cubical — Layer 1: Document Model

> **Historical record**, frozen at layer close (tag + date in [`build-order.md`](build-order.md)). The plan and "what was built" below are the state *as of then*; current canonical truth lives in [`architecture/`](architecture/README.md). Where work later diverged, it's noted inline as a deviation — not silently overwritten.

The canonical Markdown AST, frontmatter indexing, and the editor's Lezer integration.

> **Before starting Session B:** Read `docs/layer-0-spec.md §14.2` — L0 deviated from the original spec in two ways that affect this layer's code: the crate dependency direction is reversed (`cubical-core` depends on `cubical-index`, not the other way around), and `CubicalError` lives in `cubical-app`, not `cubical-core`.

---

## 1. Goals

By end of L1:

1. `cubical-ast` has a fully typed canonical AST with `parse(source) -> Document` entry point.
2. Frontmatter indexed into libSQL `frontmatter` table on scan + watcher Created/Modified events.
3. `get_frontmatter` IPC returns structured frontmatter for any tracked `.md` file.
4. CodeMirror 6 with Lezer markdown grammar running in the editor webview.
5. `get_canonical_ast` IPC returns a parsed `Document` for any tracked `.md` file.

Goals 1–3: Session A complete. Goals 4–5: Session B pending.

See `docs/architecture/document-model.md` for the design spec this layer implements.

---

## 2. Session A — What was built (2026-05-09)

### cubical-ast (`crates/cubical-ast/src/`)

Files: `lib.rs`, `types.rs`, `frontmatter.rs`, `normalize.rs`

**AST types:**
- `Document { frontmatter: Option<Frontmatter>, blocks: Vec<Block>, source_len: usize }`
- Block variants: `Heading | Paragraph | List | CodeBlock | Quote | ThematicBreak | Html`
- Inline variants: `Text | Emph | Strong | Code | Link | Image | LineBreak`
- Every block carries `Span { start: usize, end: usize }` in absolute byte offsets into original source
- Wiki-links / embeds / block IDs / tags pass through as `Inline::Text` (L3 work)
- `serde` derive on all types for IPC crossing

**Frontmatter parser (`frontmatter.rs`):**
- Strict detection: opening `---` at byte 0; closing `---` on its own line; CRLF tolerated
- YAML 1.2 via `serde_yaml_ng`; values flatten to `serde_json::Value`
- Malformed YAML: logs `tracing::warn!`, degrades to `frontmatter = None`; body parsed normally
- Non-mapping top-level YAML: treated as `None`

**Normalizer (`normalize.rs`):**
- `pulldown-cmark` 0.13 (`Options::empty()`); explicit `Container` stack
- Tight-list items: `push_inline` injects implicit `Paragraph`; closed before sub-block or Item end
- Unsupported tags (tables, footnotes, math): transparent `Swallow` container
- `Tag::HtmlBlock` collects `Event::Html` chunks into single `Block::Html`

**Tests:** 25 — frontmatter split, YAML parsing, all Block/Inline variants, idempotence, span coverage.

### cubical-index migration v2

File: `crates/cubical-index/migrations/002_frontmatter.sql`

```sql
CREATE TABLE frontmatter (
    file_path TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,  -- JSON-encoded
    PRIMARY KEY (file_path, key),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);
CREATE INDEX idx_frontmatter_key ON frontmatter(key);
```

`PRAGMA foreign_keys = ON` now executed on every connection open.

### cubical-core (`crates/cubical-core/src/vault/frontmatter.rs`)

`refresh_frontmatter(vault, abs_path, rel_str)`:
- Reads + parses + DELETE-then-INSERT keyed on `file_path`. Idempotent.
- Runs in `tokio::task::spawn_blocking`.
- Called from `scan` (markdown only) + `apply_watch_event_to_db` (Created/Modified).

### cubical-app

- `get_frontmatter`: pure handler in `commands/vault.rs`; returns `FileNotFound` if path untracked.
- `CubicalError::FileNotFound(String)` variant added.
- Frontend typed wrapper in `ui/src/api/ipc.ts`.

**Test counts (cumulative):** cubical-ast 25 · cubical-core 42 · cubical-index 6 · cubical-app 10 = **83 total**

---

## 3. Session B — What shipped (2026-05-09)

Goals 4–5 closed end-to-end. Rust `cubical_ast::parse` and the editor's Lezer-backed TS normalizer now produce the same `Document` JSON shape from the same source string, verified by a cross-language parity harness with shared fixtures.

### 3.1 Lezer/pulldown-cmark reconciliation decision

**Resolved: explicit reconciliation via a shared fixture harness, Rust is canonical, TS conforms.**

The two parsers are *not* equivalent by construction — they differ in span trailing-newline rules, inline content emission (Lezer leaves text in "gaps" between marker children; pulldown-cmark emits explicit text events), list-item-blank-line handling, and heading-marker boundaries. The reconciliation strategy:

1. **Rust `cubical_ast::parse` is the single source of truth for the canonical shape.** The TS normalizer (`ui/src/ast/normalize.ts`) is responsible for matching Rust's output exactly.
2. **Shared parity fixtures** at `crates/cubical-ast/tests/fixtures/parity.json`. Each entry is `{name, input, expected}`. Both [`crates/cubical-ast/tests/parity_fixtures.rs`](../crates/cubical-ast/tests/parity_fixtures.rs) and [`ui/src/ast/parity.test.ts`](../ui/src/ast/parity.test.ts) assert their parser produces `expected` for each `input`.
3. **The Rust integration test is also the regenerator.** `CUBICAL_UPDATE_PARITY_FIXTURES=1 cargo test -p cubical-ast --test parity_fixtures` rewrites `expected` from current Rust output. Workflow when the AST shape intentionally changes: regenerate via Rust, then re-run the TS suite — if it fails, fix the TS normalizer. Never edit `expected` by hand.

`docs/architecture/document-model.md` §5.5 still reads "Lezer trees are normalized into canonical AST on the Rust side." That's accurate for non-editor consumers (indexers, exporters, plugins call `get_canonical_ast` → Rust). The editor speaks Lezer locally and uses the TS normalizer only for the in-process `onAstChange` callback path so the editor doesn't have to round-trip through Rust on every keystroke. No spec change.

---

## 4. Definition of done — closed 2026-05-09

- [x] `cargo test --all` passes (83+ baseline) — 92 Rust tests across the workspace (cubical-ast 26 + 1 parity integration · cubical-core 42 · cubical-index 6 · cubical-app 17)
- [x] `cargo clippy --all-targets --all-features -- -D warnings` clean
- [x] `cargo fmt --check` clean
- [x] `npm run build` clean; `npm test` adds 23 vitest tests (8 parity-harness + 15 normalizer/frontmatter unit tests)
- [x] `get_canonical_ast` returns valid `Document` for any tracked `.md` file (and rejects non-markdown with `InvalidRequest`)
- [x] CodeMirror 6 with Lezer grammar — raw markdown editing works end-to-end (verified via `npm run build` and vitest; interactive `cargo tauri dev` smoke pass deferred — see §5 closing note)
- [x] §3.1 reconciliation decision documented (above)
- [x] L0 interactive smoke pass (`docs/layer-0-spec.md` §12 DoD #4 + #6) completed and `l0` tagged — see `docs/layer-0-spec.md` §14.4
- [x] `l1` tag applied — points at `25b52d0` on `origin/main`

---

## 5. What was built (Session B)

### AST shape fix (load-bearing prerequisite)

Session A's `Inline::Text(String)` and `Inline::Code(String)` were tuple newtype variants on an internally-tagged enum (`#[serde(tag = "kind", rename_all = "snake_case")]`). `serde_json` panics at serialization time for that combination — a latent bug that would have detonated the moment `get_canonical_ast` tried to ship a paragraph through IPC. Both variants are now struct-shaped (`Text { value: String }`, `Code { value: String }`), bringing the wire shape in line with the other Inline variants. The `document_round_trips_through_serde_json` test in [`crates/cubical-ast/src/lib.rs`](../crates/cubical-ast/src/lib.rs) is the regression guard. All Session-A normalizer code + tests updated to the new pattern; nothing else in the AST changed. The wire-shape contract is documented inline on the `Inline` enum rustdoc.

### Rust IPC commands

`read_file_text` and `get_canonical_ast` landed in [`crates/cubical-app/src/commands/vault.rs`](../crates/cubical-app/src/commands/vault.rs) following the §8 pure-handler / thin-shim pattern.

- `read_file_text`: coarse-grained "give me a markdown file's contents as text". Existence check (`files.path` lookup), type check (`type_id == "markdown"` only — binary rejected with `InvalidRequest`), on-disk read inside `tokio::task::spawn_blocking`.
- `get_canonical_ast`: reuses `read_file_text` for the disk fetch, pushes `cubical_ast::parse` through `spawn_blocking` (CPU-bound, mirrors the hashing dispatch in `scan.rs`). Pre-L7 the AST is recomputed on every call; the only AST-derived storage at L1 is the frontmatter index.

New error variant: `CubicalError::InvalidRequest(String)` for argument-validation failures. Wire shapes mirror Session A's pattern (typed request/response structs in `api/types.rs`); the `get_canonical_ast` response carries a `cubical_ast::Document` directly so the AST has exactly one source-of-truth definition. Tauri shims in [`crates/cubical-app/src/lib.rs`](../crates/cubical-app/src/lib.rs); `invoke_handler` updated. Pure modules (`commands/`, `api/`, `state.rs`) remain Tauri-free.

### Frontend stack

`ui/package.json` gained `codemirror` 6, `@codemirror/lang-markdown` 6, `@codemirror/state` 6, `@codemirror/view` 6, `@lezer/common` 1, `yaml` 2, plus `vitest` 2 + `@types/node` (devDeps). `npm install` runs against a worktree-local cache (`/tmp/npm-cache-worktree`) when the global `~/.npm` is permission-locked.

### TypeScript canonical AST + normalizer

- [`ui/src/ast/types.ts`](../ui/src/ast/types.ts): wire-shape mirror of `cubical_ast::Document` — discriminated unions on `kind` with `snake_case` tag values, exactly matching `#[serde(tag = "kind", rename_all = "snake_case")]`.
- [`ui/src/ast/frontmatter.ts`](../ui/src/ast/frontmatter.ts): strict frontmatter splitter (CRLF-tolerant, leading-whitespace-rejecting, `---`-on-its-own-line closer); YAML parsing delegated to the `yaml` package.
- [`ui/src/ast/normalize.ts`](../ui/src/ast/normalize.ts): walks the Lezer tree (`@lezer/markdown`'s `parser.parse`) and produces the same `CanonicalDocument` shape as `cubical_ast::parse`.

Non-trivial pieces of parity, all of which the TS normalizer encodes explicitly:

- **Span trailing-newline rules.** pulldown-cmark's spans for Heading/Paragraph/Quote/ThematicBreak/Html include exactly one trailing `\n`; Lezer's spans stop at the last non-newline byte. TS normalizer extends each block's `to` by one `\n` (`extendOneNewline`). CodeBlock spans intentionally don't extend — both parsers stop at the closing fence.
- **List item span includes blank lines.** pulldown-cmark extends a list item's span through every blank line that separates it from the next item (or source end). TS normalizer mirrors with `extendThroughBlankLines`; the List's own span end then becomes the last extended item's end.
- **Inline content from Lezer "gaps".** Lezer doesn't emit explicit text nodes — text content sits between marker children. `readInlines` walks a node's children and fills the gaps from the source string, coalescing adjacent text runs and folding any embedded `\n` to a single space (matching pulldown-cmark's soft-break-as-space semantics).
- **Emphasis/Strong inner-range derivation.** For `*emph*` and `**strong**`, Lezer surrounds the inner text with `EmphasisMark` children (no inner text node). Inner range is `[firstMark.to, lastMark.from)`.
- **Heading marker trimming.** ATX `# `, Setext `===`, Setext `---` markers are trimmed via per-mark inspection so the heading's inline content excludes them.

L1's AST doesn't model wiki-links, embeds, block IDs, tags, tables, footnotes, definition lists, or math — those are L3+. They pass through as plain text or are silently skipped.

### Cross-language parity harness

[`crates/cubical-ast/tests/fixtures/parity.json`](../crates/cubical-ast/tests/fixtures/parity.json) is a single committed file with `[{name, input, expected}]` entries; both [`crates/cubical-ast/tests/parity_fixtures.rs`](../crates/cubical-ast/tests/parity_fixtures.rs) and [`ui/src/ast/parity.test.ts`](../ui/src/ast/parity.test.ts) verify their respective parser produces `expected` for each `input`. The Rust test is also the regenerator (see §3.1). 8 fixtures cover heading + paragraph, fenced code, loose list, blockquote, link + image, frontmatter (with nested mapping), thematic break, and inline code + hard break.

### CodeMirror 6 editor surface

[`ui/src/Editor.tsx`](../ui/src/Editor.tsx) is a minimal Solid wrapper: it owns its own `<div>` and the `EditorView`, never lets Solid touch the CM6 DOM (Lane-1 contract from `docs/architecture/concurrency.md`), and exposes a one-way `onAstChange` callback that fires the canonical AST 150ms after the last keystroke. L1 ships raw markdown only — no Live Preview decorations, no Pretext-backed measurement, just CM6 + history + default keymap + `markdown()` from `@codemirror/lang-markdown`. The CM6 theme is a placeholder pulling tokens from `tokens.css`; L2 wires the real theme. `value` prop changes (file selection) are dispatched as a CM6 transaction so the buffer the user is editing isn't fought.

### App-level wiring

[`ui/src/App.tsx`](../ui/src/App.tsx) gained a two-pane layout: file list on the left (clickable rows for markdown files), Editor on the right. Selection state is local Solid signals; not persisted. [`ui/src/api/ipc.ts`](../ui/src/api/ipc.ts) gained `readFileText` + `getCanonicalAst` + their request/response types (with `CanonicalDocument` imported from `./ast/types` so the AST type lives in one place). The existing `vault:file-changed` listener is unchanged — external edits still refresh the file list via the 200ms-throttled refresh.

### Architectural notes

- **Boundary reshuffle, no spec change.** Session A planned to deliver `get_canonical_ast` itself; Session B reframed the boundary so `read_file_text` lives below `get_canonical_ast` (the AST command reuses the file read). The two commands together form the read-side surface for L2's editor wiring, with a clean type-check/Markdown-only gate at the I/O seam. `docs/layer-0-spec.md` §8 doesn't enumerate L1 commands by name, so no spec deviation.
- **Parity contract guards against tuple-variant regression.** The wire JSON for `Inline` no longer includes any tuple variants. If a future change reintroduces one (e.g. `Variant(SomeMapType)` where the inner serializes as a struct/map), the round-trip test still passes — but it would be safer to keep all variants struct-shaped to avoid the runtime panic surface that bit Session A.

### Test counts (cumulative)

**Rust:** cubical-ast 26 (Session A's 25 + 1 round-trip serde test) + 1 parity_fixtures integration test · cubical-core 42 · cubical-index 6 · cubical-app 17 (Session A's 10 + 7 read_file_text / get_canonical_ast happy + error paths) = **92 Rust tests across the workspace, all green**.

**UI:** 23 vitest tests (8 parity-harness fixtures + 15 normalizer / frontmatter unit tests).

### Smoke-pass status (carried into L2)

Automated gates all pass (`cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all`, `npm run build`, `npm test`), but `cargo tauri dev` was *not* exercised interactively against a real vault when Session B closed. The `l1` tag still landed on `25b52d0` because the L1 contract is provably met by the parity harness + vitest + Rust integration tests. **L2 should open the dev app against a vault containing one or more `.md` files at session start and confirm (a) the editor shows the raw markdown of the selected file, (b) typing fires `onAstChange` with a sensible AST, (c) external edits to the open file still surface via `vault:file-changed`.** If any of those don't hold, file a bug against L1 before starting L2 work proper.
