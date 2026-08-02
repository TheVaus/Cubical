> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Doc Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure project documentation so CLAUDE.md is a lean ~80-line session primer, docs/architecture.md is split into a focused subdirectory, and milestone history migrates losslessly into per-layer spec appendices.

**Architecture:** All content from the existing CLAUDE.md and docs/architecture.md is preserved — nothing is deleted without a destination. The split follows natural domain boundaries (vault, document model, concurrency, UI, planned, constraints). Cross-references between files are explicit links, never implicit assumptions.

**Tech Stack:** Markdown files only. Two Rust doc comment edits (no logic changes). Verify with `cargo test --all` and `npm run build` at the end.

---

## File Map

**Create (10):**
- `docs/README.md` — docs-root index for humans and subagents
- `docs/architecture/README.md` — arch index with locked-decisions authority statement
- `docs/architecture/foundation.md` — §1 Philosophy + §2 Stack
- `docs/architecture/vault.md` — §3 Vault + §4 File identity + §9 Binary assets
- `docs/architecture/document-model.md` — §5.1–§5.7 (full document model)
- `docs/architecture/concurrency.md` — §6 Concurrency + IPC
- `docs/architecture/ui.md` — §11 UI + §12 Settings
- `docs/architecture/planned.md` — §7 Sync stub + §8 Plugins stub + §10 Time Machine stub + §14 Open questions
- `docs/architecture/constraints.md` — §13 Out of scope
- `docs/layer-1-spec.md` — L1 goals + Session A record + Session B todo + DoD

**Rewrite (1):**
- `CLAUDE.md` — lean primer, ~80 lines

**Update (4):**
- `README.md` (root) — update docs/architecture.md reference
- `docs/layer-0-spec.md` — add §14 "What was built" appendix + §2 tree note
- `crates/cubical-ast/src/lib.rs` — update doc comment
- `crates/cubical-sync/src/lib.rs` — update doc comment

**Delete (1):**
- `docs/architecture.md` — fully migrated to subdirectory

**Unchanged:**
- `docs/migration-touchpoints.md`
- `docs/vault-gitignore.md`

---

### Task 1: Create docs/architecture/README.md

**Files:**
- Create: `docs/architecture/README.md`

- [ ] **Step 1: Create the architecture index**

Write `docs/architecture/README.md`:

```markdown
# Cubical — Architecture

Locked decisions. These are the result of deliberate review. They can be changed, but only by an explicit architecture review — not a session-level call. If code disagrees with a doc here, the doc wins until explicitly updated.

| Domain | File | Covers |
|---|---|---|
| Philosophy + stack | `foundation.md` | Why Cubical exists, tech choices |
| Vault + file identity | `vault.md` | Storage layout, identity model, external edits, binary assets |
| Document model | `document-model.md` | Frontmatter, wiki-links, block refs, canonical AST, tags, Pending Rewrites |
| Concurrency + IPC | `concurrency.md` | Three-lane model, command design |
| UI + settings | `ui.md` | Layout, Live Preview, theming, settings |
| Future layers | `planned.md` | Sync (L7), Plugins (L6), Time Machine (L8), open questions |
| Out of scope | `constraints.md` | Explicit non-features |
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/README.md
git commit -m "docs: add architecture/ subdirectory index"
```

---

### Task 2: Create foundation.md (§1 + §2)

**Files:**
- Create: `docs/architecture/foundation.md`
- Source: `docs/architecture.md` §1 Philosophy + §2 Stack

- [ ] **Step 1: Create foundation.md**

Write `docs/architecture/foundation.md`. Start with the lock notice, then copy §1 and §2 verbatim from `docs/architecture.md`:

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

Then paste §1 "Philosophy" and §2 "Stack" exactly as they appear in `docs/architecture.md`. No content changes.

- [ ] **Step 2: Verify**

```bash
grep "^## " docs/architecture/foundation.md
# Expected: ## 1. Philosophy   ## 2. Stack
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/foundation.md
git commit -m "docs: extract foundation.md (philosophy + stack)"
```

---

### Task 3: Create vault.md (§3 + §4 + §9)

**Files:**
- Create: `docs/architecture/vault.md`
- Source: `docs/architecture.md` §3, §4, §9

- [ ] **Step 1: Create vault.md**

Write `docs/architecture/vault.md`. Lock notice first:

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

Copy in order: §3 "The vault", §4 "File identity" (including §4.1, §4.2, §4.3), §9 "Binary assets".

In §4.3 "External edits", after the sentence mentioning Loro/CRDT post-L7, add:

```markdown
(See [`planned.md` — Sync](planned.md).)
```

- [ ] **Step 2: Verify**

```bash
grep "^## \|^### " docs/architecture/vault.md
# Expected: ## 3. The vault, ## 4. File identity, ### 4.1, ### 4.2, ### 4.3, ## 9. Binary assets
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/vault.md
git commit -m "docs: extract vault.md (vault layout, file identity, binary assets)"
```

---

### Task 4: Create document-model.md (§5.1–§5.7)

**Files:**
- Create: `docs/architecture/document-model.md`
- Source: `docs/architecture.md` §5

- [ ] **Step 1: Create document-model.md**

Write `docs/architecture/document-model.md`. Lock notice first:

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

Copy §5 "Document model" in full (§5.1 through §5.7).

Update the two internal cross-references that say "§5.6" to use anchor links:

In §5.2, replace the Pending Rewrites Cache reference with:
```markdown
they enqueue entries in the [Pending Rewrites Cache](#57-pending-rewrites-cache)
```

In §5.3, replace the Pending Rewrites Cache reference with:
```markdown
Block reference rewrites on rename go through the [Pending Rewrites Cache](#57-pending-rewrites-cache).
```

- [ ] **Step 2: Verify**

```bash
grep "^### " docs/architecture/document-model.md
# Expected: ### 5.1 Frontmatter through ### 5.7 Pending Rewrites Cache
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/document-model.md
git commit -m "docs: extract document-model.md (§5 full document model)"
```

---

### Task 5: Create concurrency.md, ui.md, constraints.md

**Files:**
- Create: `docs/architecture/concurrency.md` (source: §6)
- Create: `docs/architecture/ui.md` (source: §11 + §12)
- Create: `docs/architecture/constraints.md` (source: §13)

- [ ] **Step 1: Create concurrency.md**

Lock notice + copy §6 "Concurrency model" + §6.1 "IPC design" verbatim.

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

- [ ] **Step 2: Create ui.md**

Lock notice + copy §11 "UI" (§11.1–§11.5) + §12 "Settings" verbatim.

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

- [ ] **Step 3: Create constraints.md**

Lock notice + copy §13 "What is explicitly out of scope" verbatim.

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

- [ ] **Step 4: Verify**

```bash
grep "^## " docs/architecture/concurrency.md docs/architecture/ui.md docs/architecture/constraints.md
# Expected: ## 6. Concurrency model / ## 11. UI / ## 12. Settings / ## 13. What is explicitly out of scope
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/concurrency.md docs/architecture/ui.md docs/architecture/constraints.md
git commit -m "docs: extract concurrency.md, ui.md, constraints.md"
```

---

### Task 6: Create planned.md (§7 + §8 + §10 + §14)

**Files:**
- Create: `docs/architecture/planned.md`
- Source: `docs/architecture.md` §7, §8, §10, §14

- [ ] **Step 1: Create planned.md**

Lock notice first:

```markdown
> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
```

Copy in order: §7 "Sync", §8 "Plugins", §10 "Time Machine", §14 "Open architectural questions".

In §8.6 "File access", update the Pending Rewrites reference:

```markdown
This guarantees plugins see materialized content (with [Pending Rewrites](../document-model.md#57-pending-rewrites-cache) applied) rather than stale on-disk text.
```

- [ ] **Step 2: Verify**

```bash
grep "^## " docs/architecture/planned.md
# Expected: ## 7. Sync  ## 8. Plugins  ## 10. Time Machine  ## 14. Open architectural questions
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/planned.md
git commit -m "docs: extract planned.md (sync, plugins, time machine, open questions)"
```

---

### Task 7: Verify completeness then delete docs/architecture.md

**Files:**
- Delete: `docs/architecture.md`

- [ ] **Step 1: Verify all 14 sections are accounted for**

```bash
grep "^## " docs/architecture.md
# Must see all 14 sections. Cross-check:
# §1 Philosophy      → foundation.md     ✓
# §2 Stack           → foundation.md     ✓
# §3 The vault       → vault.md          ✓
# §4 File identity   → vault.md          ✓
# §5 Document model  → document-model.md ✓
# §6 Concurrency     → concurrency.md    ✓
# §7 Sync            → planned.md        ✓
# §8 Plugins         → planned.md        ✓
# §9 Binary assets   → vault.md          ✓
# §10 Time Machine   → planned.md        ✓
# §11 UI             → ui.md             ✓
# §12 Settings       → ui.md             ✓
# §13 Out of scope   → constraints.md    ✓
# §14 Open questions → planned.md        ✓
```

- [ ] **Step 2: Delete**

```bash
git rm docs/architecture.md
git commit -m "docs: delete architecture.md — content fully migrated to docs/architecture/"
```

---

### Task 8: Create docs/README.md

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Write docs/README.md**

```markdown
# Cubical — Documentation

## For subagents
Check your task brief for which layer you're on. Then:
- Layer work → `docs/layer-N-spec.md` (intent + what's already landed)
- Design question → `docs/architecture/README.md` (locked decisions)
- IPC or Tauri coupling → `docs/migration-touchpoints.md`
- Unsure → read `CLAUDE.md` first, then return here

## Start here
- `CLAUDE.md` — session primer: non-negotiables, conventions, session protocol, current state
- `docs/architecture/README.md` — locked architectural decisions, indexed by domain

## Layer specs
- `docs/layer-0-spec.md` — Bedrock (§1 = intent; §14 = what was built + deviations)
- `docs/layer-1-spec.md` — Document Model (§1 = goals; §2–§5 = sessions)
- *(layer-N-spec.md added when each layer becomes active)*

## Reference
- `docs/migration-touchpoints.md` — Tauri-coupled surfaces; read before any IPC changes
- `docs/vault-gitignore.md` — recommended `.gitignore` for user vaults

## Design specs
- `docs/superpowers/specs/` — design documents from planning sessions
- `docs/superpowers/plans/` — implementation plans
```

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -m "docs: add docs/README.md index for humans and subagents"
```

---

### Task 9: Create docs/layer-1-spec.md

**Files:**
- Create: `docs/layer-1-spec.md`

- [ ] **Step 1: Write layer-1-spec.md**

```markdown
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

Document the decision in §3.1. If it changes the architectural spec, update `docs/architecture/document-model.md §5.5`.

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
- [ ] L0 interactive smoke pass (`layer-0-spec.md` §12 DoD #4 + #6) completed and `l0` tagged
- [ ] `l1` tag applied only after all of the above

---

## 5. What was built (Session B)

*[To be filled in by Session B]*
```

- [ ] **Step 2: Commit**

```bash
git add docs/layer-1-spec.md
git commit -m "docs: add layer-1-spec.md (L1 goals, Session A record, Session B todo)"
```

---

### Task 10: Add §14 appendix to docs/layer-0-spec.md

**Files:**
- Modify: `docs/layer-0-spec.md`

- [ ] **Step 1: Add §2 tree note**

Find the directory tree code block (around line 64–66) that ends with:
```
└── docs/
    ├── architecture.md
    └── layer-0-spec.md
```

Add this note directly below the closing triple-backtick of the code block:

```markdown
> Note: this was the initial L0 layout. See `CLAUDE.md` for the current repository structure.
```

- [ ] **Step 2: Append §14 to end of file**

```markdown

---

## 14. What was built

### 14.1 Sessions

- **2026-05-05** — Initial workspace, Tauri scaffold, `ui/` skeleton, `tokens.css` + `base.css`, `ipc.ts`. `cargo tauri dev` verified.
- **2026-05-06 (registry)** — `FileTypeHandler` trait, `FileTypeError`, `FileTypeRegistry`, `MarkdownHandler`, `BinaryHandler`, `sha256_file_hex` helper. 10 unit tests.
- **2026-05-06 (migration runner)** — `open_index`, `Migration` struct, `MIGRATIONS` slice, `IndexError`, `001_initial.sql` (4 tables + 3 indexes). 4 `tokio::test` tests.
- **2026-05-07** — `Vault` type, `scan()`, 5 Tauri shims (`open_vault` / `cancel_vault_scan` / `get_vault_info` / `list_files` / `close_vault`), `spawn_scan_dispatcher`, `CubicalError`, frontend open-vault flow, 200ms-throttled list refresh. 28 tests total.
- **2026-05-08** — `WatchEvent` enum, `start_watcher()`, `WatcherHandle`, `notify` + `notify-debouncer-full` (100ms debounce + 25ms tick), `spawn_watcher_dispatcher`, `apply_watch_event_to_db`, audit_log rows. Frontend `VaultFileChanged` listener. 43 tests total.

### 14.2 Deviations from spec

1. **Dep direction (§2 crate graph):** `cubical-index` no longer depends on `cubical-core`; direction reversed. `cubical-core` now depends on `cubical-index` (for `IndexConn`) and on `libsql` (for `params!`).
2. **CubicalError location (§9):** lives in `cubical-app`, not `cubical-core`. Required by dep direction — must be downstream of all error sources.
3. **macOS FSEvents (§6):** `notify-debouncer-full` 0.3 coalesces synthetic Modify/Remove events in tests. Real editor flows work correctly. `translate_event` is fully unit-tested via synthetic `DebouncedEvent`s. `notify` 8.x + debouncer 0.6 is a candidate future fix.
4. **Rename persistence (§6):** `apply_watch_event_to_db` for `Renamed` refreshes `last_seen` on the from-row only — does not update the `path` column or insert a to-row. Next vault scan handles it. Proper rename handler deferred to L3 Pending Rewrites Cache.

### 14.3 Outstanding items

- `audit_log` auto-pruning to 10 000 rows (spec §7) is a TODO. Table grows unbounded until this lands.

### 14.4 Smoke test status — BLOCKING for `l0` tag

§12 DoD #4 and #6 were NOT completed interactively (non-interactive session harness).

Before tagging `l0`:
- **(a)** Run `cargo tauri dev`; open a 10-file folder; verify the five scan DoD points (§12 #4).
- **(b)** Modify a `.md` file externally; verify `vault:file-changed` reaches the frontend within ~300ms (§12 #6).
- **(c)** Recreate the `cubical-cancel-test` fixture (2000–5000 plain `.md` files outside the repo) for the cancel-during-scan check.

### 14.5 Test counts (final)

`cubical-core` 34 · `cubical-app` 5 · `cubical-index` 4 = **43 tests**

### 14.6 Session protocol change

The original guidance (§13 last line: *"each session begins by reading `CLAUDE.md`, ends by updating 'Project state'"*) is superseded. Current protocol is in `CLAUDE.md` — sessions rewrite the 4-6 line Project state block and record milestones in the relevant layer spec's "What was built" section.
```

- [ ] **Step 3: Commit**

```bash
git add docs/layer-0-spec.md
git commit -m "docs: add §14 'What was built' appendix to layer-0-spec.md"
```

---

### Task 11: Rewrite CLAUDE.md

**Files:**
- Rewrite: `CLAUDE.md`

- [ ] **Step 1: Replace CLAUDE.md entirely**

```markdown
# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node, no cloud.

This is the session primer. Read it before starting any work. For deep detail, follow the Docs pointers below. If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

---

## Docs

- **Architecture:** `docs/architecture/README.md` — locked design decisions, split by domain
- **Layer specs:** `docs/layer-N-spec.md` — intent + what landed per layer
- **Full index:** `docs/README.md` — map of every doc in the project

---

## Non-negotiables

These are load-bearing decisions. Not up for debate in a working session. Surface conflicts as architecture changes, not code changes.

- Plain `.md` files are the absolute source of truth. Everything else (libSQL, indexes, caches) is derived state rebuildable from the markdown.
- The vault is 100% portable and self-contained. No external services required to open a vault.
- No Electron, no Node.js runtime, no centralized cloud database for core storage.
- Files must survive being edited or renamed by external tools (vim, Finder, Dropbox) while the app is closed.
- Plugin code is sandboxed. The plugin ABI is WASI/WASM. JavaScript is supported as a *source language* via Javy/QuickJS-WASM, never as an unsandboxed runtime.
- Desktop only for v1. Mobile is deferred but the architecture must not preclude it.
- No file-identity UUIDs injected into any `.md` file before Layer 7. The vault is the user's vault, byte-for-byte, until sync onboarding.

---

## Session protocol

**Start:** Read this file. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file.

**During:** As work lands, update the current layer spec's in-progress section.

**End:** Rewrite the Project state block below (4-6 lines max). Never append to it — rewrite it.

---

## Build order

**v1.0 cut at end of L5.**

0. **Bedrock.** Workspace, Tauri, libSQL, file watcher, vault scan, file-type registry, frontmatter I/O, token surface. **No UUID injection.**
1. **Document Model.** Canonical Markdown AST in Rust, Lezer in CodeMirror, `get_canonical_ast` IPC, frontmatter into libSQL.
2. **Editing.** CodeMirror + Live Preview decorations, raw-source toggle, properties UI, light + dark themes. *First demo-able milestone.*
3. **Knowledge Graph.** Wiki-links, embeds, lazy block refs, backlinks, unlinked mentions, link/tag autocomplete, nested tags + virtual tag pages, rename → Pending Rewrites Cache.
4. **Search.** Tantivy full-text, Dataview-style libSQL queries, persistent search panel, Cmd/Ctrl+K Omni-Bar.
5. **Daily-Driver Polish.** Theme picker, export sanitization, perf pass, keyboard shortcuts. **Public v1.0 cut.**
6. **Plugins.** WASI host, manifest format, Web Worker runtime, Javy/QuickJS-WASM toolchain, plugin themes, ABI deprecation framework. *(Ships before sync — the plugin ABI is a one-way door once third parties depend on it; earn a stable core first.)*
7. **Sync.** Loro CRDT; frontmatter `cubical_id` UUIDs minted at onboarding; WebRTC P2P; optional E2EE relay.
8. **Time Machine.** Sync-clean-state snapshots, version history UI, 3-way merge UI. *(Post-v1.0)*
9. **Graph View.** WebGPU-rendered knowledge graph. *(Post-v1.0)*
10. **Long tail.** Canvas, mobile, anything else. *(Post-v1.0)*

**Cut features (no for v1.x):** EOF HTML-comment UUIDs, recovery waterfall (4-tier), cross-app importers, local AI / RAG / llama.cpp as a core feature, `.cubical/quarantine/` directory.

---

## Repository layout

```
cubical/
├── crates/
│   ├── cubical-core/       # vault, file watcher, file-type registry, frontmatter I/O
│   ├── cubical-ast/        # canonical Markdown AST (no Tauri deps)
│   ├── cubical-index/      # libSQL schema and queries
│   ├── cubical-search/     # Tantivy wrapper (L4)
│   ├── cubical-sync/       # CrdtBackend trait + Loro impl (Loro lands at L7)
│   └── cubical-app/        # Tauri app, depends on the above
├── ui/                     # Solid + TypeScript + Vite frontend
├── docs/
│   ├── README.md           # docs index — start here if unsure where to look
│   ├── architecture/       # locked architectural decisions (README.md is the overview)
│   ├── layer-0-spec.md     # Bedrock (complete)
│   ├── layer-1-spec.md     # Document Model (in progress)
│   ├── migration-touchpoints.md
│   └── vault-gitignore.md
├── CLAUDE.md
├── Cargo.toml
└── README.md
```

Crates without Tauri deps (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`) must remain buildable and testable without the app harness.

---

## Conventions

**Rust.** Edition 2021. `cargo fmt` and `cargo clippy -- -D warnings` clean before any commit. Errors via `thiserror` for libraries, `anyhow` for the app crate. No `unwrap()` or `expect()` outside tests and `main`.

**TypeScript.** Strict mode on. No `any`. Prettier + ESLint. Solid idioms: signals for fine-grained state, stores for structured state, `createResource` for async Tauri data.

**Tauri commands.** Coarse-grained, named as verb-noun. Every command takes a typed request struct and returns a typed response struct.

**Tests.** `cubical-core`, `cubical-ast`, `cubical-index` have unit tests. The app crate has integration tests against a temp vault. UI tests deferred until L3+.

**Commits.** Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.). One logical change per commit. Layer transitions get a tag.

**Documentation.** Every public Rust item has rustdoc. Every Tauri command has a doc comment. The architecture docs in `docs/architecture/` and layer specs in `docs/layer-N-spec.md` are the canonical reference; if code disagrees, the spec wins until explicitly updated.

---

## Project state

Current layer: 1 — Document Model
Session A complete: canonical AST + frontmatter index (`cubical-ast`, `cubical-index`, `cubical-core`).
Session B pending: Lezer in CodeMirror + `get_canonical_ast` IPC.
Next: wire Lezer into `EditorView`; expose `get_canonical_ast`; resolve Lezer/pulldown-cmark decision (see `docs/layer-1-spec.md §3.1`).
⚠ L0 interactive smoke pass (`docs/layer-0-spec.md` §12 DoD #4 + #6) still outstanding — complete before tagging `l0`.
Layer specs: `docs/layer-0-spec.md` (complete, smoke pass pending) · `docs/layer-1-spec.md` (Session B pending)
```

- [ ] **Step 2: Verify line count**

```bash
wc -l CLAUDE.md
# Expected: 75–90 lines
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md as lean session primer"
```

---

### Task 12: Update cross-references in README.md and Rust files

**Files:**
- Modify: `README.md`
- Modify: `crates/cubical-ast/src/lib.rs`
- Modify: `crates/cubical-sync/src/lib.rs`

- [ ] **Step 1: Update root README.md**

Find: `See \`CLAUDE.md\` for the working short form and \`docs/architecture.md\` for the canonical long form.`

Replace with: `See \`CLAUDE.md\` for the session primer and \`docs/architecture/\` for the canonical architectural reference.`

- [ ] **Step 2: Update cubical-ast doc comment**

In `crates/cubical-ast/src/lib.rs`, find the line containing `docs/architecture.md §5.5` and replace with:

```rust
//! See `docs/architecture/document-model.md` — "Canonical AST".
```

- [ ] **Step 3: Update cubical-sync doc comment**

In `crates/cubical-sync/src/lib.rs`, find the line containing `docs/architecture.md §7` and replace with:

```rust
//! See `docs/architecture/planned.md` — "Sync (Layer 7)".
```

- [ ] **Step 4: Verify no remaining stale references**

```bash
grep -r "docs/architecture\.md" . --include="*.md" --include="*.rs" --include="*.ts" \
  --exclude-dir=".git" --exclude-dir=".claude"
# Expected: no output
```

- [ ] **Step 5: Commit**

```bash
git add README.md crates/cubical-ast/src/lib.rs crates/cubical-sync/src/lib.rs
git commit -m "docs: update all cross-references to docs/architecture/ subdirectory"
```

---

### Task 13: Final verification

- [ ] **Step 1: Confirm all new files exist**

```bash
ls docs/architecture/
# Expected: README.md concurrency.md constraints.md document-model.md
#           foundation.md planned.md ui.md vault.md

ls docs/
# Expected: README.md architecture/ layer-0-spec.md layer-1-spec.md
#           migration-touchpoints.md vault-gitignore.md superpowers/
```

- [ ] **Step 2: Confirm architecture.md is gone**

```bash
test -f docs/architecture.md && echo "STILL EXISTS — fix this" || echo "correctly deleted"
```

- [ ] **Step 3: Verify no broken references**

```bash
grep -r "docs/architecture\.md" . --include="*.md" --include="*.rs" --include="*.ts" \
  --exclude-dir=".git" --exclude-dir=".claude"
# Expected: no output
```

- [ ] **Step 4: Run tests**

```bash
cargo test --all 2>&1 | tail -5
# Expected: test result: ok. 83 passed; 0 failed
```

- [ ] **Step 5: Run clippy and fmt**

```bash
cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
# Expected: both exit 0
```

- [ ] **Step 6: Run frontend build**

```bash
cd ui && npm run build 2>&1 | tail -5
# Expected: build succeeds
```

- [ ] **Step 7: Confirm clean working tree**

```bash
git status
# Expected: nothing to commit, working tree clean
```
