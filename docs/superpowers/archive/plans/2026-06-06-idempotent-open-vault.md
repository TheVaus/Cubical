# Idempotent `open_vault` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-opening a vault whose folder is already open in-process returns the existing session instead of throwing Tantivy `LockBusy` by trying to acquire a second index-writer lock on the same directory.

**Architecture:** Extract the dedup decision into a pure `find_open_vault_by_canonical_path` helper (canonicalizes each open vault's root and compares to the canonicalized incoming path), unit-tested directly without an `AppHandle`. `open_vault` calls it under a read guard before constructing a `Vault`; on a match it returns the existing `vault_id` + that vault's current `scan_status`.

**Tech Stack:** Rust, Tokio, Tauri. Changes confined to `crates/cubical-app/src/commands/vault.rs`. No `cubical-core` / `cubical-search` / UI changes.

**Design spec:** `docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md`

---

## File structure

- **Modify** `crates/cubical-app/src/commands/vault.rs`:
  - Add private fn `find_open_vault_by_canonical_path` (just above `pub async fn open_vault`, after the `From<ScanStatusBackend> for ScanStatus` impl).
  - Add the early-return guard at the top of `open_vault` (before `let vault = Vault::open(&req.path).await?;`).
  - Add two `#[tokio::test]`s in the existing `mod tests`.

That's the entire change. No other files.

---

### Task 1: Pure `find_open_vault_by_canonical_path` helper (TDD)

**Files:**
- Modify: `crates/cubical-app/src/commands/vault.rs` (new private fn + 2 tests in `mod tests`)

- [ ] **Step 1: Write the failing tests**

In `crates/cubical-app/src/commands/vault.rs`, inside `mod tests` (after the `fresh_state_with_vault` helper, around line 728), add:

```rust
#[tokio::test]
async fn reopen_same_path_returns_existing_vault() {
    let (dir, _vault, state) = fresh_state_with_vault("v1").await;
    // `incoming` is canonicalized the way open_vault canonicalizes req.path.
    let incoming = std::fs::canonicalize(dir.path()).unwrap();
    let guard = state.vaults().read().await;
    let found = find_open_vault_by_canonical_path(&guard, &incoming);
    assert_eq!(
        found,
        Some(("v1".to_string(), ScanStatusBackend::Complete))
    );
}

#[tokio::test]
async fn reopen_different_path_returns_none() {
    let (_dir_a, _vault_a, state) = fresh_state_with_vault("v1").await;
    // A directory that is NOT registered in state.
    let dir_b = tempdir().unwrap();
    let incoming = std::fs::canonicalize(dir_b.path()).unwrap();
    let guard = state.vaults().read().await;
    assert_eq!(find_open_vault_by_canonical_path(&guard, &incoming), None);
}
```

> Note: `fresh_state_with_vault` inserts the open vault with `ScanStatusBackend::Complete`, which is why the first test expects `Complete`. The stored vault root is the raw `dir.path()` (un-canonicalized); the helper canonicalizes it, so the comparison also exercises symlink resolution (e.g. macOS `/var` → `/private/var`).

- [ ] **Step 2: Run tests to verify they fail (compile error)**

Run: `cargo test -p cubical-app find_open_vault_by_canonical_path 2>&1 | tail -20` (or build the test target)
Expected: FAIL — `cannot find function find_open_vault_by_canonical_path in this scope`.

- [ ] **Step 3: Write the helper**

In `crates/cubical-app/src/commands/vault.rs`, immediately **above** `pub async fn open_vault` (after the `impl From<ScanStatusBackend> for ScanStatus { … }` block that ends around line 41), add:

```rust
/// Find an already-open vault whose canonical root matches `incoming`
/// (a path the caller has already canonicalized), for an idempotent
/// re-open. `Vault` stores its root un-canonicalized, so each stored
/// root is canonicalized here for comparison; a stored root that no
/// longer canonicalizes (e.g. its directory was removed) simply does
/// not match. Returns the existing vault id and its current scan status.
fn find_open_vault_by_canonical_path(
    vaults: &std::collections::HashMap<String, OpenVault>,
    incoming: &std::path::Path,
) -> Option<(String, ScanStatusBackend)> {
    vaults.iter().find_map(|(id, ov)| {
        let root = std::fs::canonicalize(ov.vault.root()).ok()?;
        (root.as_path() == incoming).then(|| (id.clone(), ov.scan_status))
    })
}
```

> `ScanStatusBackend` derives `Copy` (`crates/cubical-app/src/state.rs:136`), so `ov.scan_status` copies out from behind the `&OpenVault` borrow. `OpenVault`, `ScanStatusBackend`, and `Vault::root()` are already in scope in this module; `std::collections::HashMap` / `std::path::Path` are fully qualified to avoid new imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p cubical-app find_open_vault_by_canonical_path 2>&1 | tail -20`
Expected: PASS — both `reopen_same_path_returns_existing_vault` and `reopen_different_path_returns_none` pass.

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-app/src/commands/vault.rs
git commit -m "feat(open-vault): find_open_vault_by_canonical_path helper + unit tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the guard into `open_vault`

**Files:**
- Modify: `crates/cubical-app/src/commands/vault.rs` (`open_vault` body)

- [ ] **Step 1: Add the early-return guard**

In `pub async fn open_vault`, the body currently begins:

```rust
) -> Result<OpenVaultResponse, CubicalError> {
    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
```

Insert the guard **between** the `{` and the `let vault = …` line, so it reads:

```rust
) -> Result<OpenVaultResponse, CubicalError> {
    // Idempotent re-open: if this folder is already open in-process,
    // return the existing session rather than constructing a second
    // Vault (and a second Tantivy IndexWriter) on the same directory,
    // which throws LockBusy. Identity is the canonical path; a failed
    // canonicalize (missing path, etc.) falls through to Vault::open,
    // which reports the proper VaultError.
    if let Ok(incoming) = std::fs::canonicalize(&req.path) {
        let guard = state.vaults().read().await;
        if let Some((existing_id, status)) =
            find_open_vault_by_canonical_path(&guard, &incoming)
        {
            return Ok(OpenVaultResponse {
                vault_id: existing_id,
                scan_status: status.into(),
            });
        }
    }

    let vault = Vault::open(&req.path).await?;
    let vault_id = state.new_vault_id();
```

Leave the rest of `open_vault` unchanged.

> The read guard is held only across the synchronous helper call (no `.await` under it) and dropped at the end of the `if let Ok(...)` block. `status.into()` uses the existing `From<ScanStatusBackend> for ScanStatus` impl.

- [ ] **Step 2: Verify it compiles and clippy is clean**

Run: `cargo clippy -p cubical-app --all-targets -- -D warnings 2>&1 | tail -15`
Expected: clean (no warnings/errors).

- [ ] **Step 3: Run the cubical-app test suite**

Run: `cargo test -p cubical-app 2>&1 | tail -15`
Expected: all pass, including the two Task 1 tests.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/commands/vault.rs
git commit -m "fix(open-vault): idempotent re-open avoids Tantivy LockBusy

open_vault constructed a second Vault (second IndexWriter) on the same
.cubical/search directory before any path dedup, so re-opening an
already-open folder threw 'search index error: ... LockBusy'. Guard the
top of open_vault: if the canonical path is already open, return the
existing vault_id + its current scan_status. A failed canonicalize falls
through to Vault::open's existing error path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full gate sweep

**Files:** none (verification only)

- [ ] **Step 1: Run all six gates**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cd ui && npx tsc --noEmit && npm run build && npx vitest run
```

Expected: all green. (UI gates are unchanged by this Rust-only fix — they confirm no incidental breakage. Rust test count = prior + 2.)

> If `cargo test --workspace` reports a failure in `cubical-index::tags::cascade_delete_removes_tag_rows`, re-run it in isolation (`cargo test -p cubical-index --lib cascade_delete_removes_tag_rows`); it is a known pre-existing libSQL parallel-execution flake unrelated to this change. A clean `--workspace` re-run is the gate.

- [ ] **Step 2: No commit** — verification only.

---

### Task 4: Operator smoke + finish

**Files:**
- Modify: `docs/layer-4-spec.md` (or wherever the operator records app-level bug fixes) — optional one-line note; see Step 2.

- [ ] **Step 1: Operator smoke**

Build and run: `cargo tauri dev`. Open any vault folder. Then use File → Open Vault and select the **same** folder again.
Expected: no "search index error" / `LockBusy`; the app stays on that vault (idempotent — the existing session is returned). Then open a **different** folder and confirm it opens as a distinct vault.

> jsdom/unit tests cannot exercise the real Tauri open-vault path (it needs an `AppHandle`); the helper unit tests cover the dedup decision and this smoke covers the end-to-end early-return. Record the result.

- [ ] **Step 2: Record + finish the branch**

Note the fix in the project state (CLAUDE.md Project state — a one-line "open_vault LockBusy on re-open fixed" entry) if the operator wants it logged there; the design + plan docs already capture detail. Then use `superpowers:finishing-a-development-branch` to merge to `main`. No tag needed (bug-fix patch).

---

## Self-review

**Spec coverage:**
- Canonical-path identity → Task 1 helper (`std::fs::canonicalize` both sides). ✓
- Guard placement before `Vault::open` → Task 2. ✓
- Return existing `vault_id` + current `scan_status` (`.into()`) → Task 2. ✓
- Error semantics preserved (failed canonicalize falls through) → Task 2 guard comment + `if let Ok`. ✓
- No `OpenVault`/`vault_id`/IndexWriter-lifetime changes → only a private fn + a guard added; confirmed by file-structure section. ✓
- Concurrency note (read guard held only across sync compare) → Task 2 note. ✓
- Tests: same-path returns existing id, different-path returns none → Task 1. ✓
- Six gates → Task 3. ✓
- Operator smoke → Task 4. ✓

**Placeholder scan:** none — all code and commands concrete.

**Type consistency:** `find_open_vault_by_canonical_path(&HashMap<String, OpenVault>, &Path) -> Option<(String, ScanStatusBackend)>` is identical in the helper definition (Task 1 Step 3), the tests (Task 1 Step 1), and the call site (Task 2 Step 1). Call site converts `status: ScanStatusBackend` via `.into()` to `ScanStatus` for `OpenVaultResponse.scan_status` (matching the existing `From` impl and the field type used in the unchanged tail of `open_vault`). `state.vaults().read().await` derefs to `&HashMap<String, OpenVault>`, matching the helper's first parameter.
