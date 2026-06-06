# Design — Idempotent `open_vault` (fix Tantivy `LockBusy` on re-open)

**Status:** approved 2026-06-06. Focused bug-fix in the Rust app layer
(`cubical-app`). Independent of the L4-A-fix.1 embed scroll fix.

## Problem

Opening a vault whose folder is **already open in the running process**
fails with:

```
search index error: tantivy: Failed to acquire Lockfile: LockBusy.
Some("Failed to acquire index lock. ... there is already an
`IndexWriter` working on this `Directory`, in this process or in a
different process.")
```

## Root cause (confirmed)

`crates/cubical-app/src/commands/vault.rs` — `open_vault` calls
`Vault::open(&req.path)` **unconditionally** at the top (line 54).
`Vault::open` → `cubical_search::SearchIndex::open` →
`index.writer(50_000_000)` (`crates/cubical-search/src/index.rs:70`),
which acquires Tantivy's **exclusive writer lock** on
`<vault>/.cubical/search/` for the lifetime of the `IndexWriter`.

`vault_id` is a fresh monotonic counter (`v1`, `v2`, … —
`state.rs:179`, `new_vault_id()`), **not** derived from the path. Open
vaults live in `Arc<RwLock<HashMap<String, OpenVault>>>` keyed by that
ephemeral id, so there is **no path-based dedup**. Re-opening the same
folder mints a new id and constructs a *second* `Vault` — a second
`IndexWriter` on the same directory — while the first `Vault`'s writer
is still alive in the map. Tantivy returns `LockBusy`; it surfaces as
`VaultError::Search` → `CubicalError` ("search index error: …").

**Evidence:** with the app running on `cubical-l4a-smoke`, `lsof` shows
the live `cubical-app` process holding
`…/cubical-l4a-smoke/.cubical/search/.tantivy-writer.lock`; re-opening
that same folder triggers the error. Verified the code path: no
`contains_key` / path check precedes the `Vault::open` at line 54.

## Approach (chosen): idempotent re-open by canonical path

Before constructing a new `Vault`, detect that the requested path is
already open and return the existing session.

### 1. Identity = canonical path

`Vault` stores `root` un-canonicalized (`vault/mod.rs:104,145`), and the
same folder can arrive in different spellings (trailing slash, `..`,
symlink, case on case-insensitive APFS). Identity is therefore
`std::fs::canonicalize(path)`.

- Canonicalize the incoming `req.path` **once**.
- For each currently-open vault, canonicalize its `vault.root()` and
  compare to the incoming canonical path.

Open-vault count is tiny (typically 0–1), so per-call `canonicalize` of
stored roots is negligible and avoids changing the already-large
`OpenVault` struct or its shared `OpenVault::new` constructor (used by
both `open_vault` and test fixtures).

### 2. Guard in `open_vault` (before line 54)

```rust
// Idempotent re-open: if this folder is already open in-process, return
// the existing session rather than constructing a second Vault (and a
// second Tantivy IndexWriter) on the same directory — which throws
// LockBusy. Identity is the canonical path; the stored root is not
// canonicalized, so canonicalize both sides for comparison.
if let Ok(incoming) = std::fs::canonicalize(&req.path) {
    let guard = state.vaults().read().await;
    if let Some((existing_id, existing)) = guard.iter().find(|(_, ov)| {
        std::fs::canonicalize(ov.vault.root())
            .map(|root| root == incoming)
            .unwrap_or(false)
    }) {
        return Ok(OpenVaultResponse {
            vault_id: existing_id.clone(),
            scan_status: existing.scan_status.into(),
        });
    }
}
// No match (or canonicalize failed): fall through to the existing open
// path unchanged.
let vault = Vault::open(&req.path).await?;
// … rest of open_vault unchanged …
```

`ScanStatusBackend` → wire `ScanStatus` reuses the existing
`From<ScanStatusBackend> for ScanStatus` impl (`vault.rs:33`).
`ScanStatusBackend` derives `Copy` (`state.rs:136`), so
`existing.scan_status.into()` copies out from behind the read guard
without a borrow problem.

### 3. Return semantics

A matched re-open returns the **existing** `vault_id` and that vault's
**current** `scan_status` (e.g. `Complete` if its scan already
finished). No second scan, no second watcher, no second `Vault`. The
frontend consumes the returned `vault_id` and focuses the already-open
vault — the desired UX.

### 4. Error semantics preserved

If `std::fs::canonicalize(&req.path)` fails (path missing, permission),
the guard is skipped and control falls through to the unchanged
`Vault::open(&req.path)`, which already maps to the correct
`VaultError::NotFound` / `NotWritable` / `NotADirectory`. The existing
core test `open_errors_when_path_does_not_exist` is unaffected.

## Concurrency (documented limitation, not fixed)

Two *concurrent* `open_vault` calls on the same *new* path could both
miss the pre-check and race into `Vault::open`, where the second still
hits `LockBusy`. This is not a real user path — vault opening goes
through a modal OS file dialog, one selection at a time — and the
reported bug is sequential re-open. The read-lock is held only across
the synchronous canonicalize/compare (no `.await` under the guard);
no cross-task open serialization is added (that would be
over-engineering for a non-occurring scenario).

## Cross-process case (explicitly out of scope)

A genuinely different process holding the lock (a second app instance)
still surfaces the raw `LockBusy` as a "search index error". Turning
that into an actionable "vault already open in another window" message
is a separate, lower-priority improvement, deferred by operator
decision in this session.

## Scope guard — not touched

- `IndexWriter` lifetime model (stays per-vault).
- `vault_id` generation / `OpenVault` fields / `OpenVault::new`.
- The cross-process LockBusy message.
- Any `cubical-search` or `cubical-core` code — the fix lives entirely
  in the `open_vault` command.

## Testing (TDD)

`crates/cubical-app/src/commands/vault.rs` `tests` module (mirrors the
existing command-test harness that builds an `AppState` + test
`AppHandle`):

1. **`reopen_same_path_returns_existing_vault_id`** — open a temp vault,
   capture `vault_id`; call `open_vault` again with the same path;
   assert: (a) returns the **same** `vault_id`, (b) `Ok` (no
   `LockBusy`), (c) the vaults map holds exactly **one** entry. This
   fails today (second open → `LockBusy`) and passes after the fix.
2. **`reopen_different_path_opens_distinct_vault`** — open two temp
   vaults at different paths; assert two distinct `vault_id`s and two
   map entries (guards against over-matching).

Optionally exercise a non-canonical spelling (e.g. a trailing-slash or
`./` variant of the same path) to confirm canonical identity — only if
the test harness makes constructing that variant cheap; otherwise the
two cases above are sufficient.

## Definition of done

- Re-opening an already-open vault returns the existing `vault_id`
  without `LockBusy`.
- Opening a genuinely different folder still creates a distinct vault.
- Existing path-error semantics unchanged.
- Six gates green: `cargo test --workspace`, `cargo clippy --workspace
  --all-targets -- -D warnings`, `cargo fmt --all --check`, and in
  `ui/`: `npx tsc --noEmit`, `npm run build`, `npx vitest run`.
- Operator smoke: with the fix built, open a folder, then open the same
  folder again — no error, the app stays on that vault.
- Land on `main` (no tag needed; bug-fix patch).
