# Cubical — Layer 1: Document Model

The canonical Markdown AST, frontmatter indexing, and the editor's Lezer integration.

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

## 3. Session B — Pending

### Deliverables

**3a. Lezer in CodeMirror (frontend)**

Install `@codemirror/lang-markdown` + `@lezer/markdown` in `ui/`. Wire Lezer markdown grammar into `EditorView`. Raw markdown editing must work. Live Preview decorations are L2 — do not implement here.

**3b. `get_canonical_ast` IPC**

Pure handler in `crates/cubical-app/src/commands/vault.rs`. Reads the file at the given vault-relative path, calls `cubical_ast::parse(source)` (already implemented in Session A), returns `Document` as JSON. Frontend typed wrapper in `ui/src/api/ipc.ts`.

### Open decision — resolve in §3.1

`docs/architecture/document-model.md` §5.5 states: *"Lezer trees are normalized into canonical AST on the Rust side."* In practice, Rust produces canonical AST via `parse(source)` using pulldown-cmark; Lezer is the editor's live parser. Session B must decide:

> Are pulldown-cmark and Lezer treated as producing equivalent output by construction, or do they require explicit reconciliation?

Document the decision in §3.1. If it changes the architectural spec, update `docs/architecture/document-model.md` §5.5.

### 3.1 Lezer/pulldown-cmark reconciliation decision

*[To be filled in by Session B]*

---

## 4. Definition of done

- [ ] `cargo test --all` passes (83+ baseline)
- [ ] `cargo clippy --all-targets --all-features -- -D warnings` clean
- [ ] `cargo fmt --check` clean
- [ ] `npm run build` clean
- [ ] `get_canonical_ast` returns valid `Document` for any tracked `.md` file
- [ ] CodeMirror 6 with Lezer grammar — raw markdown editing works end-to-end
- [ ] §3.1 reconciliation decision documented
- [ ] L0 interactive smoke pass (`docs/layer-0-spec.md` §12 DoD #4 + #6) completed and `l0` tagged
- [ ] `l1` tag applied only after all of the above

---

## 5. What was built (Session B)

*[To be filled in by Session B]*
