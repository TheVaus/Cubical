> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Scan Link-Resolution Perf Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N²) per-file wiki-link resolution in the bulk vault scan with a single post-walk resolution pass backed by an index built once, restoring linear scan time on large vaults and fixing forward-reference resolution.

**Architecture:** Today the bulk scan calls `refresh_links` once per markdown file inside the walk loop; each call re-runs `SELECT path FROM files` (`list_known_paths`) and a linear `resolve_target` per link — O(N²) for N files. This plan splits the scan into two passes: **Pass 1** (the existing walk) hashes, upserts `files`, refreshes frontmatter + tags, and *buffers* extracted link occurrences in memory without resolving them; **Pass 2** runs once after the walk, builds a `PathResolver` index from the now-complete `files.path` set, resolves every buffered link in O(1) (common case), and writes the `links` rows. The watcher's single-file path and the public `resolve_target` semantics are untouched.

**Tech Stack:** Rust, `tokio` (async + `spawn_blocking`), `libsql` (local SQLite), `cubical-ast` (markdown `Document` parse), existing `cubical-index` query helpers.

---

## Background — the problem and the "why"s

**Read this before touching code.** It is the full context; you have none otherwise.

### What's wrong

On a 30,000-file vault (`~/Developer/sandbox/cubical-cancel-test`, 124 MB) Cubical's vault-open scan takes *minutes*; Obsidian loads the same folder in a small fraction of that. Root-cause investigation (recorded in `docs/layer-3-spec.md` §5.6) found the dominant cost is an **O(N²) algorithm in the bulk scan's link resolution**:

- `crates/cubical-core/src/vault/scan.rs` walks every file and, for each markdown file, calls `refresh_links(&vault, abs, rel)`.
- `refresh_links` (in `crates/cubical-core/src/vault/links.rs`) calls `list_known_paths(vault)` — `SELECT path FROM files ORDER BY path` — which materializes the **entire** `files.path` column into a `Vec<String>`.
- It then calls `resolve_target(target, &files)` for each wiki-link in the file. `resolve_target` is a **linear scan** of that Vec (up to three passes: exact → basename-ci → suffix-ci), with `.to_lowercase()` allocations.

Because `refresh_links` runs **once per file** and `list_known_paths` grows from 1 row to N rows as the scan progresses, the cumulative work is ≈ N²/2 row-materializations plus O(N) per link. At N=30,000 that is the multi-minute cost.

### Why it exists (not a designed-in tradeoff)

`refresh_links` was written for the **single-file watcher path** (`apply_watch_event_to_db` in `crates/cubical-app/src/events.rs`): when one note changes, loading all paths once and resolving its links is perfectly fine — O(N) for a single edit. The initial bulk scan loop **reused that single-file helper unchanged**, turning O(N)-per-edit into O(N²)-for-N-files. No agent flagged it; it is invisible in every spec and was never planned or recorded until 2026-05-28.

### Why we fix it now (and not at the planned L5 perf pass)

- `docs/architecture/foundation.md` principle #2 (a *locked* decision): *"Performance is a feature, not a polish item... 'Fast enough' is not the bar. 'Imperceptible' is."* A quadratic in the core scan path is not a "polish-later" item under the project's own constitution.
- The scheduled L5 perf pass (build-order item 5) targets a *different*, secondary problem (the 3× parse, §5.5). **It would leave this quadratic intact.** Fixing the parse count makes the scan ~4× faster but still O(N²).
- Sessions F–K (blocks, embeds, unlinked-mentions) each add more per-file scan work. Built on a quadratic foundation they compound it and make it harder to isolate. Fixing now, before they land, is the cheap window.

### Why a *second pass* (correctness, not just speed)

Resolving links *during* the walk is also partly **incorrect**: a file walked before its link target exists in the `files` table resolves to `NULL` (a forward reference). The bug only self-heals on a later rescan. A post-walk pass resolves against the complete file set, so forward references resolve on the first scan. This is the behavioral anchor for the regression test in Task 4.

### Scope boundaries — do NOT do these

- **Do NOT touch the 3× parse / multi-read issue (§5.5).** That is deliberately deferred to L5; the shared-`Document` refactor ripples through the public API and would be redone as F–K add consumers. Link *extraction* keeps its own parse in Pass 1. We are only moving link *resolution*.
- **Do NOT change the watcher's single-file path.** `refresh_links` stays and is still called by `apply_watch_event_to_db`. It is O(N)-per-edit, which is correct for one file.
- **Do NOT change resolution *semantics*.** The exact → basename-ci (unique) → suffix-ci (unique) order, the ambiguity→`None` rules, and the empty-target→`None` rule must be byte-for-byte preserved. Only the time complexity changes. `resolve_target`'s existing tests must stay green.
- **Do NOT add a public-API change** to crates other than the internal `cubical-core::vault` module surface.

---

## File Structure

- **Modify `crates/cubical-core/src/vault/links.rs`** — add a `PathResolver` index type (`build` + `resolve`), refactor `resolve_target` to delegate to it (DRY, keeps watcher + tests intact), and add a `pub(crate)` `extract_links_off_executor` that parses + extracts without resolving or writing.
- **Modify `crates/cubical-core/src/vault/scan.rs`** — split `scan()` into Pass 1 (walk: buffer link extractions instead of calling `refresh_links`) and Pass 2 (resolve buffered links once against a `PathResolver`, write rows in a batched transaction). Add the forward-reference regression test.
- No other files change. `events.rs` (watcher) keeps calling `refresh_links` unchanged.

### Types you will use (already defined — do not redefine)

From `crates/cubical-core/src/vault/links.rs`:
```rust
pub struct LinkExtraction {
    pub target_raw: String,
    pub anchor: Option<cubical_ast::Anchor>, // Heading { value } | Block { value }
    pub display: Option<String>,
    pub is_embed: bool,
    pub position: u64,
}
pub fn extract_links(doc: &cubical_ast::Document) -> Vec<LinkExtraction>;
pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String>;
async fn parse_off_executor(abs_path: &Path) -> Option<cubical_ast::Document>; // private today
```
From `crates/cubical-index` (re-exported at crate root): `LinkRow`, `replace_links_for_file(conn, source_path, &[LinkRow])`.

> **Before Task 1:** open `crates/cubical-core/src/vault/links.rs` and confirm the exact field names/visibility of `LinkExtraction` and the signature of `extract_links`. If `LinkExtraction` or `extract_links` is private, widen to `pub(crate)`. Adjust the code blocks below if the real field names differ (e.g. `display` vs `display_text`).

---

### Task 1: `PathResolver` index with semantic-equivalence tests

**Files:**
- Modify: `crates/cubical-core/src/vault/links.rs`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `links.rs`:

```rust
#[test]
fn path_resolver_matches_resolve_target_semantics() {
    let files = vec![
        "a.md".to_string(),
        "notes/b.md".to_string(),
        "notes/sub/c.md".to_string(),
        "Dup.md".to_string(),
        "other/Dup.md".to_string(), // ambiguous basename "dup"
    ];
    let r = PathResolver::build(files.clone());
    // For a battery of targets, PathResolver must agree with resolve_target.
    for target in [
        "a", "a.md", "b", "notes/b", "c", "sub/c.md", "Dup", "dup",
        "missing", "", "  ", "B", "NOTES/B",
    ] {
        assert_eq!(
            r.resolve(target),
            resolve_target(target, &files),
            "mismatch for target {target:?}"
        );
    }
}

#[test]
fn path_resolver_resolves_exact_and_basename_in_constant_lookups() {
    // Build once, resolve many — proves resolution does not re-scan per call.
    let files: Vec<String> = (0..1000).map(|i| format!("dir/n{i:04}.md")).collect();
    let r = PathResolver::build(files);
    assert_eq!(r.resolve("n0500"), Some("dir/n0500.md".to_string()));
    assert_eq!(r.resolve("dir/n0999.md"), Some("dir/n0999.md".to_string()));
    assert_eq!(r.resolve("nope"), None);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p cubical-core vault::links::tests::path_resolver -- --nocapture`
Expected: FAIL to compile — `PathResolver` does not exist yet.

- [ ] **Step 3: Implement `PathResolver`**

Add to `links.rs` (above the `tests` module). It mirrors `resolve_target`'s three-stage order; exact + basename are O(1) via maps, the rare suffix fallback stays linear over `all`:

```rust
use std::collections::HashMap;

/// Index over the vault's `files.path` set for wiki-link resolution.
///
/// Built once per bulk scan (and per single-file watcher edit) rather
/// than re-scanning a `&[String]` for every link. Resolution order is
/// identical to [`resolve_target`]: exact (with/without `.md`) →
/// unique case-insensitive basename → unique case-insensitive suffix.
/// Exact and basename lookups are O(1); the suffix stage is a linear
/// fallback over `all` and only runs when the first two miss (rare —
/// only for targets that don't match a real note).
pub struct PathResolver {
    /// Every path, verbatim — used for the exact stage and the suffix
    /// fallback. Order is irrelevant.
    all: Vec<String>,
    /// Lowercased basename (without `.md`) AND lowercased basename
    /// (with `.md`) → the paths carrying it. A target resolves at this
    /// stage only when exactly one path maps to it.
    by_basename: HashMap<String, Vec<usize>>,
    /// Verbatim path string → index, for the exact-with-extension hit.
    exact: HashMap<String, usize>,
    /// Path-without-`.md` → index, for the exact-without-extension hit.
    exact_stem: HashMap<String, usize>,
}

impl PathResolver {
    /// Build the index from the complete path set. O(N).
    #[must_use]
    pub fn build(paths: Vec<String>) -> Self {
        let mut by_basename: HashMap<String, Vec<usize>> = HashMap::new();
        let mut exact: HashMap<String, usize> = HashMap::new();
        let mut exact_stem: HashMap<String, usize> = HashMap::new();
        for (i, f) in paths.iter().enumerate() {
            exact.insert(f.clone(), i);
            if let Some(stem) = f.strip_suffix(".md") {
                exact_stem.insert(stem.to_string(), i);
            }
            let base = f.rsplit('/').next().unwrap_or(f);
            let base_no_ext = base.strip_suffix(".md").unwrap_or(base);
            by_basename
                .entry(base_no_ext.to_lowercase())
                .or_default()
                .push(i);
            // Also key by the with-extension basename so a target like
            // "b.md" matches at the basename stage, mirroring resolve_target.
            if base != base_no_ext {
                by_basename.entry(base.to_lowercase()).or_default().push(i);
            }
        }
        // De-duplicate index lists so a file keyed under both basename
        // forms is not double-counted when the two forms collide.
        for v in by_basename.values_mut() {
            v.sort_unstable();
            v.dedup();
        }
        Self {
            all: paths,
            by_basename,
            exact,
            exact_stem,
        }
    }

    /// Resolve a wiki-link target to a vault-relative path, or `None`
    /// when there is no unique match. Semantics identical to
    /// [`resolve_target`].
    #[must_use]
    pub fn resolve(&self, target_raw: &str) -> Option<String> {
        let target = target_raw.trim();
        if target.is_empty() {
            return None;
        }
        // 1) exact (with or without .md)
        if let Some(&i) = self.exact.get(target) {
            return Some(self.all[i].clone());
        }
        if let Some(&i) = self.exact_stem.get(target) {
            return Some(self.all[i].clone());
        }
        // 2) unique basename match, case-insensitive
        let target_lower = target.to_lowercase();
        if let Some(idxs) = self.by_basename.get(&target_lower) {
            if idxs.len() == 1 {
                return Some(self.all[idxs[0]].clone());
            } else if idxs.len() > 1 {
                return None; // ambiguous basename → unresolved
            }
        }
        // 3) unique path-suffix match, case-insensitive (linear fallback)
        let mut suffix_matches = self
            .all
            .iter()
            .filter(|f| f.to_lowercase().ends_with(&target_lower));
        let first = suffix_matches.next();
        match (first, suffix_matches.next()) {
            (Some(f), None) => Some(f.clone()),
            _ => None,
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p cubical-core vault::links::tests::path_resolver -- --nocapture`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-core/src/vault/links.rs
git commit -m "feat(core): PathResolver — O(1) wiki-link resolution index"
```

---

### Task 2: Refactor `resolve_target` to delegate to `PathResolver` (DRY, keep watcher + tests green)

**Files:**
- Modify: `crates/cubical-core/src/vault/links.rs` (`resolve_target` body only)

- [ ] **Step 1: Replace `resolve_target`'s body with a delegation**

Keep the exact same signature so the watcher path and all existing tests are untouched at the call site:

```rust
/// Resolve a wiki-link target against a snapshot of `files.path`.
///
/// Thin wrapper over [`PathResolver`] kept for the single-file watcher
/// path (one edit → one build → resolve this file's links). The bulk
/// scan builds a `PathResolver` once and calls `.resolve()` directly.
pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String> {
    PathResolver::build(files.to_vec()).resolve(target_raw)
}
```

- [ ] **Step 2: Run the full links test suite to verify nothing regressed**

Run: `cargo test -p cubical-core vault::links -- --nocapture`
Expected: PASS — all pre-existing `resolve_target` tests (exact / basename-ci / unique-suffix / ambiguity / empty) still green, plus Task 1's tests.

- [ ] **Step 3: Commit**

```bash
git add crates/cubical-core/src/vault/links.rs
git commit -m "refactor(core): resolve_target delegates to PathResolver"
```

---

### Task 3: `extract_links_off_executor` — parse + extract without resolving or writing

**Files:**
- Modify: `crates/cubical-core/src/vault/links.rs`
- Test: same file `tests` module

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn extract_links_off_executor_returns_occurrences_without_db() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.md");
    std::fs::write(&p, "see [[b]] and [[c|display]] plus ![[d]]\n").unwrap();
    let got = extract_links_off_executor(&p).await;
    let targets: Vec<&str> = got.iter().map(|e| e.target_raw.as_str()).collect();
    assert_eq!(targets, vec!["b", "c", "d"]);
    assert!(got.iter().any(|e| e.is_embed)); // ![[d]]
}

#[tokio::test]
async fn extract_links_off_executor_unreadable_file_returns_empty() {
    let got = extract_links_off_executor(std::path::Path::new("/no/such/file.md")).await;
    assert!(got.is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-core vault::links::tests::extract_links_off_executor -- --nocapture`
Expected: FAIL to compile — `extract_links_off_executor` does not exist.

- [ ] **Step 3: Implement the helper**

Add to `links.rs`. It reuses the existing private `parse_off_executor` + `extract_links`:

```rust
/// Parse `abs_path` off the runtime and return its wiki-link
/// occurrences, **without** resolving them or touching the DB. Used by
/// the bulk scan's Pass 1 to buffer extractions for a single post-walk
/// resolution pass (Pass 2). Returns an empty vec when the file can't
/// be read/parsed — mirrors `refresh_links`'s "no links" policy.
pub(crate) async fn extract_links_off_executor(abs_path: &Path) -> Vec<LinkExtraction> {
    match parse_off_executor(abs_path).await {
        Some(doc) => extract_links(&doc),
        None => Vec::new(),
    }
}
```

> If `LinkExtraction` is not at least `pub(crate)`, widen it now: `pub(crate) struct LinkExtraction`. If `extract_links` is private, widen to `pub(crate)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p cubical-core vault::links::tests::extract_links_off_executor -- --nocapture`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-core/src/vault/links.rs
git commit -m "feat(core): extract_links_off_executor — parse+extract, no resolve/write"
```

---

### Task 4: Two-pass scan — buffer extractions, resolve once after the walk

**Files:**
- Modify: `crates/cubical-core/src/vault/scan.rs`
- Test: same file `tests` module

- [ ] **Step 1: Write the failing regression test (forward reference)**

Add to the `tests` module in `scan.rs`. This FAILS on the current per-file code (`aaa.md` is walked before `zzz.md` exists in `files`, so the old loop resolves `[[zzz]]` to `NULL`) and PASSES after the two-pass fix:

```rust
#[tokio::test]
async fn scan_resolves_forward_references() {
    use cubical_index::links_from;
    let dir = tempdir().unwrap();
    // Alphabetical walk order: aaa.md is visited before zzz.md, so the
    // old per-file resolution could not see zzz.md yet → NULL. The
    // post-walk resolution pass must resolve it on the first scan.
    fs::write(dir.path().join("aaa.md"), "forward ref to [[zzz]]\n").unwrap();
    fs::write(dir.path().join("zzz.md"), "body\n").unwrap();
    let vault = Vault::open(dir.path()).await.expect("open");

    let (tx, _rx) = mpsc::channel::<ScanProgress>(64);
    let cancel = CancellationToken::new();
    scan(vault.clone(), cancel, tx).await.expect("scan");

    let rows = links_from(vault.index(), "aaa.md").await.expect("query");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target_path.as_deref(), Some("zzz.md"));
}
```

- [ ] **Step 2: Run to verify it fails on current code**

Run: `cargo test -p cubical-core vault::scan::tests::scan_resolves_forward_references -- --nocapture`
Expected: FAIL — `assertion failed: rows[0].target_path == Some("zzz.md")` (it is `None` today). This proves the defect.

- [ ] **Step 3: Update the imports in `scan.rs`**

Change the `use` for the vault link helper. Replace `links::refresh_links` with the extraction helper and the resolver/row types:

```rust
use crate::vault::{
    frontmatter::refresh_frontmatter,
    links::{extract_links_off_executor, LinkExtraction, PathResolver},
    tags::refresh_tags,
    Vault, VaultError,
};
use cubical_index::{replace_links_for_file, LinkRow};
use cubical_ast::Anchor;
```

- [ ] **Step 4: In the walk loop, buffer extractions instead of calling `refresh_links`**

Before the walk loop starts (near the `files_processed`/`files_total_estimate` declarations), add the buffer:

```rust
// Pass-1 buffer: link occurrences per source file. Resolution is
// deferred to Pass 2 (after the walk) so it sees the COMPLETE file
// set — both for correctness (forward references) and to avoid the
// O(N²) of re-loading the path set per file. See
// docs/layer-3-spec.md §5.6.
let mut pending_links: Vec<(String, Vec<LinkExtraction>)> = Vec::new();
```

Then in the per-markdown-file block, **replace** the `refresh_links(...)` call (keep `refresh_frontmatter` and `refresh_tags` exactly as they are):

```rust
        if type_id == "markdown" {
            if let Err(e) = refresh_frontmatter(&vault, &abs_path, &path_str).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "frontmatter refresh failed");
            }
            // L3 §5.6: defer link RESOLUTION to Pass 2; just extract +
            // buffer here. Extraction still parses the file (the §5.5
            // multi-parse is a separate, deferred issue).
            let extractions = extract_links_off_executor(&abs_path).await;
            if !extractions.is_empty() {
                pending_links.push((path_str.clone(), extractions));
            }
            // L3 Session D: tags still refresh inline.
            if let Err(e) = refresh_tags(&vault, &abs_path, &path_str).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "tags refresh failed");
            }
        }
```

- [ ] **Step 5: After the walk loop, replace the trailing commit with "commit Pass 1, then run Pass 2"**

Locate the trailing commit at the very end of `scan()` (just before `tracing::info!(... "scan complete")` and `Ok(files_processed)`):

```rust
    // Commit the trailing partial batch.
    tx.commit().await.map_err(IndexError::from)?;
```

**Replace exactly those two lines** with the block below. (The first statement is the *same* Pass-1 commit, just re-commented; do not leave the old `tx.commit()` in place as well or you will double-commit an already-consumed transaction.) The `tracing::info!` + `Ok(files_processed)` that follow stay untouched.

```rust
    // Commit Pass 1 so the files table is complete and visible to the
    // resolution query below.
    tx.commit().await.map_err(IndexError::from)?;

    // ---- Pass 2: resolve all buffered links against the complete file
    // set, once. O(N) build + O(1) common-case lookups. Replaces the
    // old O(N²) per-file resolve. See docs/layer-3-spec.md §5.6.
    let known_paths = {
        let mut rows = conn
            .query("SELECT path FROM files ORDER BY path", ())
            .await
            .map_err(IndexError::from)?;
        let mut v = Vec::new();
        while let Some(row) = rows.next().await.map_err(IndexError::from)? {
            v.push(row.get::<String>(0).map_err(IndexError::from)?);
        }
        v
    };
    let resolver = PathResolver::build(known_paths);

    let mut link_tx = conn.transaction().await.map_err(IndexError::from)?;
    let mut link_batch: u32 = 0;
    for (source_path, extractions) in pending_links {
        if cancel.is_cancelled() {
            link_tx.commit().await.map_err(IndexError::from)?;
            return Err(VaultError::ScanCancelled);
        }
        let rows: Vec<LinkRow> = extractions
            .into_iter()
            .map(|e| {
                let target_path = resolver.resolve(&e.target_raw);
                let (anchor_kind, anchor_value) = match e.anchor {
                    Some(Anchor::Heading { value }) => (Some("heading".to_string()), Some(value)),
                    Some(Anchor::Block { value }) => (Some("block".to_string()), Some(value)),
                    None => (None, None),
                };
                LinkRow {
                    target_raw: e.target_raw,
                    target_path,
                    anchor_kind,
                    anchor_value,
                    display_text: e.display,
                    is_embed: e.is_embed,
                    position: e.position,
                }
            })
            .collect();
        if let Err(e) = replace_links_for_file(vault.index(), &source_path, &rows).await {
            tracing::warn!(path = %source_path, error = %e, "links resolve/write failed");
        }
        link_batch += 1;
        if link_batch >= SCAN_BATCH_SIZE {
            link_tx.commit().await.map_err(IndexError::from)?;
            link_tx = conn.transaction().await.map_err(IndexError::from)?;
            link_batch = 0;
        }
    }
    link_tx.commit().await.map_err(IndexError::from)?;
```

> Note: the `LinkRow` field names (`target_raw`, `target_path`, `anchor_kind`, `anchor_value`, `display_text`, `is_embed`, `position`) must match `cubical-index`'s `LinkRow`. They are copied from the current `refresh_links` body — confirm against `crates/cubical-core/src/vault/links.rs` if the compiler complains.
> Note: `Anchor` import path — if `cubical_ast::Anchor` differs, match the path used at the top of `links.rs`.
> Note: `LinkExtraction.display` — if the real field is named differently, adjust `display_text: e.display`.

- [ ] **Step 6: Run the forward-reference test — it must now pass**

Run: `cargo test -p cubical-core vault::scan::tests::scan_resolves_forward_references -- --nocapture`
Expected: PASS — `aaa.md`'s link resolves to `zzz.md` on the first scan.

- [ ] **Step 7: Run the existing link + scan tests — nothing regressed**

Run: `cargo test -p cubical-core vault::scan -- --nocapture`
Expected: PASS — including `scan_populates_links_table_and_resolves_targets` (resolved + NULL-for-missing still correct) and the cancellation test.

- [ ] **Step 8: Commit**

```bash
git add crates/cubical-core/src/vault/scan.rs
git commit -m "perf(core): resolve scan links in one O(N) post-walk pass (fixes §5.6 O(N²))"
```

---

### Task 5: Full verification + gates

- [ ] **Step 1: Whole workspace test suite**

Run: `cargo test --workspace`
Expected: PASS, 0 failures. (Note: `commands::vault::tests::get_setting_returns_none_for_absent_key` is a known parallel-execution flake — if it fails, re-run it in isolation: `cargo test -p cubical-app commands::vault::tests::get_setting_returns_none_for_absent_key`.)

- [ ] **Step 2: Lint + format + frontend gates**

Run, expecting all clean:
```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
( cd ui && npx tsc --noEmit && npx vitest run && npm run build )
```

- [ ] **Step 3: Real-vault smoke (the original symptom)**

Open the 30k-file vault and confirm the scan completes in seconds, not minutes:
```bash
cargo build -p cubical-app
# then: cargo tauri dev, open ~/Developer/sandbox/cubical-cancel-test,
# watch the footer "Scanning… X / Y" reach completion. Sanity-check a
# couple of backlinks/wiki-links resolve.
```
If hands-on `cargo tauri dev` isn't possible in your environment, record that honestly (as prior sessions did) — the forward-reference test + the existing resolution tests already prove correctness; the smoke only confirms wall-clock feel.

- [ ] **Step 4: Update docs + state**

- In `docs/layer-3-spec.md` §5.6, change the opening to past tense ("**Fixed YYYY-MM-DD.**") and note the two-pass `PathResolver` design that landed.
- Add a short §9.x closeout entry for this session (mirror the §9.5 Session E style): what landed, the design, tests added, and the smoke status.
- Rewrite the `CLAUDE.md` "Project state" block (do not append): note the perf fix landed, update test counts, and set "Next: L3 Session F — Link + tag autocomplete."

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **Semantics preserved:** Task 1's `path_resolver_matches_resolve_target_semantics` test is the guard — if `PathResolver::resolve` ever diverges from `resolve_target`, it fails. Keep both in lockstep.
- **The behavioral anchor** for the perf change is the forward-reference test (Task 4), not a timing assertion — timing tests are flaky and forbidden. The O(N²) cannot return without either re-introducing per-file `list_known_paths` (which would also break the forward-ref guarantee) or removing Pass 2.
- **Out of scope, on purpose:** the 3× parse (§5.5). Do not be tempted to "also fix the double parse while here" — it is a public-API refactor deferred to L5 for documented reasons.
- **Watcher untouched:** `refresh_links` still exists and is still called by `apply_watch_event_to_db`. Do not delete it.
