> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Recent-vaults store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the vault-switcher real memory — a machine-local recent-vaults list (OS app-config dir) that records vaults on open, auto-opens the last vault on launch, and drives one-click switching with graceful handling of missing folders.

**Architecture:** A Rust module in `cubical-app` (the Tauri shell) owns `recent_vaults.json` in the OS app-config dir; recording folds into the existing `open_vault` shim, and two new IPC commands expose list/remove. The frontend extracts a reusable `openVaultByPath`, auto-opens the top existing entry on launch, and renders the list (switch / greyed-missing / prune) in both the switcher popover and the empty-vault landing.

**Tech Stack:** Rust (Tauri 2, serde, serde_json), SolidJS/TypeScript, CodeMirror-adjacent app shell, Vitest + `cargo test`.

Design spec: [`2026-07-09-recent-vaults-store-design.md`](../specs/2026-07-09-recent-vaults-store-design.md).

## Global Constraints

- **Machine-local app-shell state only.** Never touches any `.md` file or a vault's `.cubical/`. Lives in `cubical-app`, never in `cubical-engine`.
- **No new Tauri plugin.** Reach the OS app-config dir via Tauri core `app.path().app_config_dir()` (`use tauri::Manager;`).
- **Recents never block an open.** Every store read/write is best-effort: a missing/corrupt file, or an unavailable app-config dir, degrades to an empty list / no-op — it must never fail `open_vault` or throw in the frontend.
- **Store shape:** JSON array of `{ "path": String, "last_opened_unix": i64 }`, most-recent-first, **capped at 10** (LRU eviction). `record` dedupes by path (move-to-top + update timestamp). Missing folders are **never auto-pruned** — only greyed and removed on explicit user action.
- **Recording is single-source:** folded into the `open_vault` shim on `Ok` only. The frontend never calls an "add" command.
- **Green gate:** this feature adds Rust, so the full `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) is in play. Per task, run at minimum the focused Rust/TS tests named in the task.

---

### Task 1: Rust `recent_vaults` store module (pure logic + DTOs)

**Files:**
- Modify: `crates/cubical-app/Cargo.toml` (add serde, serde_json, dev tempfile)
- Create: `crates/cubical-app/src/recent_vaults.rs` (+ inline `#[cfg(test)]` tests)
- Modify: `crates/cubical-app/src/lib.rs:21` (add `mod recent_vaults;`)

**Interfaces:**
- Produces:
  - `pub struct RecentVaultEntry { pub path: String, pub last_opened_unix: i64 }` (`Serialize, Deserialize, PartialEq, Clone, Debug`)
  - `pub struct RecentVault { pub path: String, pub last_opened_unix: i64, pub exists: bool }` (`Serialize, Clone, Debug`)
  - `pub struct ListRecentVaultsResponse { pub vaults: Vec<RecentVault> }` (`Serialize`)
  - `pub struct RemoveRecentVaultRequest { pub path: String }` (`Deserialize`)
  - `pub fn load(store: &Path) -> Vec<RecentVaultEntry>`
  - `pub fn record(store: &Path, vault_path: &str, now_unix: i64)`
  - `pub fn remove(store: &Path, vault_path: &str)`
  - `pub fn list_with_existence(store: &Path) -> Vec<RecentVault>`
  - `pub const CAP: usize = 10;`

- [ ] **Step 1: Add dependencies** — in `crates/cubical-app/Cargo.toml`, under `[dependencies]` (after the tracing lines):

```toml
serde = { workspace = true }
serde_json = { workspace = true }
```

and add a dev-dependencies section (after `[features]` or before it — top-level table):

```toml
[dev-dependencies]
tempfile = { workspace = true }
```

- [ ] **Step 2: Write the failing tests** — create `crates/cubical-app/src/recent_vaults.rs` with ONLY the tests first (so it fails to compile → the RED signal). Put this at the bottom of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store_path(dir: &std::path::Path) -> std::path::PathBuf {
        dir.join("recent_vaults.json")
    }

    #[test]
    fn load_missing_file_is_empty() {
        let dir = tempdir().unwrap();
        assert!(load(&store_path(dir.path())).is_empty());
    }

    #[test]
    fn load_corrupt_file_is_empty() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(load(&p).is_empty());
    }

    #[test]
    fn record_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        let got = load(&p);
        assert_eq!(got, vec![RecentVaultEntry { path: "/vaults/a".into(), last_opened_unix: 100 }]);
    }

    #[test]
    fn record_dedupes_and_moves_to_top_with_new_timestamp() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        record(&p, "/vaults/b", 200);
        record(&p, "/vaults/a", 300); // a re-opened: moves to top, ts updated
        let got = load(&p);
        assert_eq!(got.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["/vaults/a", "/vaults/b"]);
        assert_eq!(got[0].last_opened_unix, 300);
    }

    #[test]
    fn record_caps_at_ten_and_evicts_oldest() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        for i in 0..12 {
            record(&p, &format!("/vaults/v{i}"), i as i64);
        }
        let got = load(&p);
        assert_eq!(got.len(), CAP);
        // most-recent-first: v11 at top, v2 at bottom; v0/v1 evicted.
        assert_eq!(got.first().unwrap().path, "/vaults/v11");
        assert_eq!(got.last().unwrap().path, "/vaults/v2");
    }

    #[test]
    fn remove_drops_matching_entry() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        record(&p, "/vaults/a", 100);
        record(&p, "/vaults/b", 200);
        remove(&p, "/vaults/a");
        assert_eq!(load(&p).iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["/vaults/b"]);
    }

    #[test]
    fn list_stamps_existence_and_does_not_mutate() {
        let dir = tempdir().unwrap();
        let p = store_path(dir.path());
        let real = dir.path().to_string_lossy().to_string(); // an existing dir
        record(&p, &real, 100);
        record(&p, "/definitely/missing/vault", 200);
        let listed = list_with_existence(&p);
        // ordering preserved (most-recent first): missing entry on top.
        assert_eq!(listed[0].path, "/definitely/missing/vault");
        assert!(!listed[0].exists);
        assert_eq!(listed[1].path, real);
        assert!(listed[1].exists);
        // list did not prune the missing entry from disk.
        assert_eq!(load(&p).len(), 2);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail** — `cargo test -p cubical-app recent_vaults`
Expected: compile error (the module has no `load`/`record`/etc. yet).

- [ ] **Step 4: Implement the module** — prepend above the tests in `crates/cubical-app/src/recent_vaults.rs`:

```rust
//! Recent-vaults store — machine-local app-shell state (not vault content).
//!
//! A small JSON list of the vaults the user has opened, kept in the OS
//! app-config dir so the switcher can offer one-click switching and the
//! app can auto-open the last vault on launch. Owned by the Tauri shell
//! (`cubical-app`); the engine stays vault-focused. Every operation is
//! best-effort — recents must never block opening a vault, so write
//! failures are swallowed and a missing/corrupt file reads as empty.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Max entries retained; the oldest is evicted past this.
pub const CAP: usize = 10;

/// One persisted entry (on-disk shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentVaultEntry {
    pub path: String,
    pub last_opened_unix: i64,
}

/// A list entry enriched with a live existence check (IPC shape).
#[derive(Debug, Clone, Serialize)]
pub struct RecentVault {
    pub path: String,
    pub last_opened_unix: i64,
    pub exists: bool,
}

/// Response for `list_recent_vaults`.
#[derive(Debug, Clone, Serialize)]
pub struct ListRecentVaultsResponse {
    pub vaults: Vec<RecentVault>,
}

/// Request for `remove_recent_vault`.
#[derive(Debug, Clone, Deserialize)]
pub struct RemoveRecentVaultRequest {
    pub path: String,
}

/// Read the store. A missing or unparseable file yields an empty list —
/// this is disposable state, never an error.
pub fn load(store: &Path) -> Vec<RecentVaultEntry> {
    match std::fs::read(store) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Record a vault open: dedupe by path (move to top, update timestamp),
/// cap at [`CAP`], and atomically write. Best-effort — a write failure is
/// swallowed so it can never fail the open that triggered it.
pub fn record(store: &Path, vault_path: &str, now_unix: i64) {
    let mut entries = load(store);
    entries.retain(|e| e.path != vault_path);
    entries.insert(
        0,
        RecentVaultEntry { path: vault_path.to_string(), last_opened_unix: now_unix },
    );
    entries.truncate(CAP);
    let _ = atomic_write(store, &entries);
}

/// Drop the matching entry (explicit user prune). Best-effort write.
pub fn remove(store: &Path, vault_path: &str) {
    let mut entries = load(store);
    let before = entries.len();
    entries.retain(|e| e.path != vault_path);
    if entries.len() != before {
        let _ = atomic_write(store, &entries);
    }
}

/// Load and stamp each entry with a live directory-existence check.
/// Does not mutate the store — a temporarily-missing vault (unmounted
/// drive) survives to be reconnected rather than being silently pruned.
pub fn list_with_existence(store: &Path) -> Vec<RecentVault> {
    load(store)
        .into_iter()
        .map(|e| {
            let exists = Path::new(&e.path).is_dir();
            RecentVault { path: e.path, last_opened_unix: e.last_opened_unix, exists }
        })
        .collect()
}

/// Write via temp-file + rename so a crash mid-write can't corrupt the
/// store (mirrors the discipline of `cubical-core::vault::atomic`).
fn atomic_write(store: &Path, entries: &[RecentVaultEntry]) -> std::io::Result<()> {
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(entries)?;
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, store)?;
    Ok(())
}
```

- [ ] **Step 5: Register the module** — in `crates/cubical-app/src/lib.rs`, add next to `mod tauri_sink;` (line 21):

```rust
mod recent_vaults;
```

- [ ] **Step 6: Run tests to verify they pass** — `cargo test -p cubical-app recent_vaults`
Expected: all 7 tests PASS.

- [ ] **Step 7: Lint** — `cargo clippy -p cubical-app --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add crates/cubical-app/Cargo.toml crates/cubical-app/src/recent_vaults.rs crates/cubical-app/src/lib.rs Cargo.lock
git commit -m "feat(app): recent-vaults store module (load/record/remove/list)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: IPC commands + record-on-open wiring + frontend bindings

**Files:**
- Modify: `crates/cubical-app/src/lib.rs` (imports, path helper, 2 command shims, register in `generate_handler!`, fold recording into `open_vault`)
- Modify: `ui/src/api/ipc.ts` (DTO interfaces + 2 command wrappers)

**Interfaces:**
- Consumes (Task 1): `recent_vaults::{list_with_existence, remove, record, ListRecentVaultsResponse, RemoveRecentVaultRequest}`.
- Produces (Rust commands): `list_recent_vaults() -> ListRecentVaultsResponse`, `remove_recent_vault(RemoveRecentVaultRequest)`.
- Produces (TS): `interface RecentVault { path: string; last_opened_unix: number; exists: boolean }`, `interface ListRecentVaultsResponse { vaults: RecentVault[] }`, `interface RemoveRecentVaultRequest { path: string }`, `function listRecentVaults(): Promise<ListRecentVaultsResponse>`, `function removeRecentVault(req: RemoveRecentVaultRequest): Promise<void>`.

**Note:** command-level Tauri shims need an `AppHandle` for the app-config dir and can't be unit-tested without a running app, so the store *logic* is already covered by Task 1's tests; this task's verification is `cargo build`/`clippy` + `tsc`. This is thin wiring, not new logic.

- [ ] **Step 1: Add the Manager import** — at the top of `crates/cubical-app/src/lib.rs`, add to the existing `use` block:

```rust
use tauri::Manager;
```

- [ ] **Step 2: Add the path helper + two command shims** — in `crates/cubical-app/src/lib.rs`, near the other `#[tauri::command]` functions (e.g. right after the `open_vault` shim at line 145):

```rust
/// Resolve the recent-vaults store file in the OS app-config dir, or
/// `None` if the platform can't give us one (recents then no-op).
fn recent_vaults_store(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("recent_vaults.json"))
}

/// Tauri command — list recent vaults, most-recent first, each stamped
/// with a live existence check. Absent store or config dir → empty list.
#[tauri::command]
fn list_recent_vaults(app: tauri::AppHandle) -> recent_vaults::ListRecentVaultsResponse {
    let vaults = recent_vaults_store(&app)
        .map(|p| recent_vaults::list_with_existence(&p))
        .unwrap_or_default();
    recent_vaults::ListRecentVaultsResponse { vaults }
}

/// Tauri command — remove one entry from the recent-vaults list.
#[tauri::command]
fn remove_recent_vault(app: tauri::AppHandle, req: recent_vaults::RemoveRecentVaultRequest) {
    if let Some(p) = recent_vaults_store(&app) {
        recent_vaults::remove(&p, &req.path);
    }
}
```

- [ ] **Step 3: Fold recording into `open_vault`** — replace the body of the `open_vault` shim (`crates/cubical-app/src/lib.rs:134-145`) with:

```rust
async fn open_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    let vault_path = req.path.to_string_lossy().to_string();
    let resp = commands::vault::open_vault(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app.clone())),
        req,
    )
    .await?;
    // Record the successful open in the machine-local recents (best-effort;
    // never fails the open).
    if let Some(store) = recent_vaults_store(&app) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        recent_vaults::record(&store, &vault_path, now);
    }
    Ok(resp)
}
```

- [ ] **Step 4: Register the two commands** — in the `tauri::generate_handler!` list (`crates/cubical-app/src/lib.rs:76+`), add two entries (e.g. after `open_vault,`):

```rust
            list_recent_vaults,
            remove_recent_vault,
```

- [ ] **Step 5: Build + lint the Rust side** — `cargo build -p cubical-app && cargo clippy -p cubical-app --all-targets -- -D warnings`
Expected: builds clean, no clippy warnings. (`AppHandle` is `Clone`, so `app.clone()` into the sink while keeping `app` for recording compiles.)

- [ ] **Step 6: Add the frontend DTOs + wrappers** — in `ui/src/api/ipc.ts`, add the interfaces in the interface section (near `OpenVaultResponse`, ~line 30):

```ts
export interface RecentVault {
  path: string;
  last_opened_unix: number;
  exists: boolean;
}

export interface ListRecentVaultsResponse {
  vaults: RecentVault[];
}

export interface RemoveRecentVaultRequest {
  path: string;
}
```

and the two command wrappers in the Commands section (near `openVault`, ~line 467):

```ts
export function listRecentVaults(): Promise<ListRecentVaultsResponse> {
  return invoke("list_recent_vaults");
}

export function removeRecentVault(req: RemoveRecentVaultRequest): Promise<void> {
  return invoke("remove_recent_vault", { req });
}
```

- [ ] **Step 7: Typecheck the frontend** — `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add crates/cubical-app/src/lib.rs ui/src/api/ipc.ts
git commit -m "feat(app): list/remove recent-vault IPC + record on open_vault

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract `openVaultByPath` (behavior-preserving refactor)

**Files:**
- Modify: `ui/src/App.tsx:1470-1666` (`handleOpen` → thin dialog wrapper + new `openVaultByPath`)

**Interfaces:**
- Produces: `const openVaultByPath: (path: string) => Promise<void>` — runs the full open-and-seed flow for a known path (owns `setBusy`/error handling). `handleOpen` calls it after the dialog.
- Consumes (later task): Task 4 calls `openVaultByPath` for launch auto-open and recent-list clicks.

**Note:** pure refactor — no behavior change to the dialog flow, so no new test; the gate is existing green + operator smoke.

- [ ] **Step 1: Introduce `openVaultByPath` and slim `handleOpen`** — replace the whole `handleOpen` definition (`ui/src/App.tsx:1470-1666`) with:

```tsx
  /**
   * Open the vault at `path`: reset prior UI state, open it via IPC, and
   * seed this vault's settings. Owns busy + error handling. Shared by the
   * folder-picker (`handleOpen`), the recent-vaults list, and launch
   * auto-open.
   */
  const openVaultByPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      // Reset any prior vault's UI state before the new one fires events.
      setFiles([]);
      setFolders([]);
      setFilesProcessed(0);
      setFilesTotalEstimate(0);
      setScanStatus("in_progress");
      setVaultPath(path);
      setSelectedPath(null);
      setSelectedContent(null);
      setPropertiesFrontmatter(null);
      setBlockCount(0);
      setWordCount(0);
      setConflictExternalHash(null);
      setRawOverride(null);
      setCreateOffer(null);
      setRightSidebarRefreshTick(0);
      setBrokenBlockRefs([]);
      setPendingRewritesCount(0);
      setContextMenu(null);
      setDeleteTarget(null);
      setRenamingPath(null);
      setTagRefreshTick(0);
      setView({ kind: "file" });
      setRightSidebarCollapsed(false);
      setRightSidebarPanel("backlinks");
      setShortcutOverrides({});
      setWikilinkResolver(null);
      setEmbedResolver(null);
      setPropertyResolver(null);
      setDataviewRunner(null);
      setAutocompleteProvider(null);
      seenHash = null;
      lastWrittenHash = null;
      dirty = false;

      const resp = await openVault({ path });
      setVaultId(resp.vault_id);
      setScanStatus(resp.scan_status);
      setWikilinkResolver(createWikiLinkResolver(resp.vault_id));
      setEmbedResolver(createEmbedResolver(resp.vault_id));
      setPropertyResolver(createPropertyResolver(resp.vault_id));
      setDataviewRunner(
        createDataviewRunner(resp.vault_id, (p) =>
          void handleNavigateWikilink(p, null),
        ),
      );
      setAutocompleteProvider(createAutocompleteProvider(resp.vault_id));
      scheduleRefresh();

      // Apply this vault's stored theme preference, if any. Absent
      // key → keep the current (OS-default `system`) mode.
      try {
        const stored = await getSetting(resp.vault_id, "appearance.theme_mode");
        if (stored !== null) {
          setThemeMode(stored);
          setResolvedTheme(applyTheme(stored));
        }
      } catch (e) {
        console.error("loading theme_mode failed", e);
      }

      await seedSetting(
        resp.vault_id,
        "editor.raw_source_default",
        false,
        setRawDefault,
      );
      await seedSetting(
        resp.vault_id,
        "editor.minimap_enabled",
        false,
        setMinimapEnabled,
      );
      await seedSetting(
        resp.vault_id,
        "editor.colorize_raw_source",
        false,
        setColorizeSource,
      );
      await seedSetting(
        resp.vault_id,
        "wikilinks.rewrite_broken_links_on_rename",
        true,
        setRewriteBrokenLinks,
      );
      await seedSetting(
        resp.vault_id,
        "properties.typed_enabled",
        false,
        setTypedProps,
      );
      await seedSetting(
        resp.vault_id,
        "properties.date_format_default",
        "YYYY-MM-DD",
        setDateDefault,
      );
      await seedSetting(
        resp.vault_id,
        "properties.default_currency",
        "usd",
        setCurrencyDefault,
      );
      await seedSetting(
        resp.vault_id,
        "properties.tags_key_as_tags",
        true,
        setTagsKeyAsTags,
      );

      // Load each core plugin's enablement (absent ⇒ default).
      {
        const enab: Record<string, boolean> = {};
        for (const p of CORE_PLUGINS) {
          try {
            const stored = await getSetting(resp.vault_id, p.settingKey);
            enab[p.id] = stored ?? p.defaultEnabled;
          } catch (e) {
            console.error(`loading ${p.settingKey} failed`, e);
            enab[p.id] = p.defaultEnabled;
          }
        }
        setCorePlugins(enab);
      }

      // Seed status-bar config (master + each segment). Absent ⇒ default (on).
      {
        const cfg: Record<string, boolean> = {};
        const keys: BooleanSettingKey[] = [
          STATUSBAR_ENABLED_KEY,
          ...STATUSBAR_SEGMENTS.map((s) => s.settingKey),
        ];
        for (const k of keys) {
          try {
            cfg[k] = (await getSetting(resp.vault_id, k)) ?? STATUSBAR_DEFAULT;
          } catch (e) {
            console.error(`loading ${k} failed`, e);
            cfg[k] = STATUSBAR_DEFAULT;
          }
        }
        setStatusbarConfig(cfg);
      }

      await seedSetting(
        resp.vault_id,
        "ui.right_sidebar_collapsed",
        false,
        setRightSidebarCollapsed,
      );
      await seedSetting(
        resp.vault_id,
        "ui.right_sidebar_panel",
        "backlinks",
        setRightSidebarPanel,
      );
      await seedSetting(
        resp.vault_id,
        "shortcuts.overrides",
        {},
        setShortcutOverrides,
      );
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await openVaultByPath(picked);
  };
```

> Preserve any seed-setting lines present in the current `handleOpen` body that are not shown above verbatim — the block between the reset and the `catch` must be transplanted whole. If the live file has extra seeds beyond this list, keep them in the same order.

- [ ] **Step 2: Typecheck + test** — `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean, 728/728 (no test changes; behavior-preserving).

- [ ] **Step 3: Operator smoke** — `npm run tauri dev`: open a vault via the folder picker; confirm it still opens and seeds identically (theme, sidebars, status bar) — the extraction changed nothing user-visible.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "refactor(app): extract openVaultByPath from handleOpen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend recents UI + wiring

The `VaultSwitcher` prop change breaks its only call site (`App.tsx`), so the shared component, the switcher rewire, and the full App wiring land **together in one green commit** — they are a single contract change and can't compile apart.

**Files:**
- Create: `ui/src/RecentVaultList.tsx`
- Modify: `ui/src/VaultSwitcher.tsx` (new props, render the list via `RecentVaultList`)
- Modify: `ui/src/styles/layout.css` (recent-row + missing state; reuse existing tokens)
- Modify: `ui/src/App.tsx` — imports; `recentVaults` signal + `refreshRecentVaults`; refresh after open/remove; launch auto-open in the existing `onMount`; VaultSwitcher call site (new props); `.empty-vault` landing list.

**Interfaces:**
- Consumes: `type RecentVault`, `listRecentVaults`, `removeRecentVault` (Task 2); `openVaultByPath` (Task 3).
- Produces:
  - `RecentVaultList` component with props `{ vaults: RecentVault[]; onSwitch: (path: string) => void; onRemove: (path: string) => void }`. Renders one row per vault: an existing vault is a button that calls `onSwitch(path)`; a missing vault (`exists === false`) renders greyed with a "missing" hint and a **×** that calls `onRemove(path)` (and does not switch).
  - `VaultSwitcherProps` gains `recentVaults?: RecentVault[]`, `onSwitch: (path: string) => void`, `onRemove: (path: string) => void` (replacing the old `recentVaults?: { path: string }[]`).

- [ ] **Step 1: Create `RecentVaultList`** — `ui/src/RecentVaultList.tsx`:

```tsx
import { For, Show } from "solid-js";

import type { RecentVault } from "./api/ipc";

/**
 * Shared list of recent vaults, used by the vault-switcher popover and
 * the empty-vault landing. An existing vault is a one-click switch; a
 * missing one (folder deleted/moved/unmounted) is greyed with a × to
 * prune it. Presentational — all persistence flows through the callbacks.
 */
export interface RecentVaultListProps {
  vaults: RecentVault[];
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
}

function vaultName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function RecentVaultList(props: RecentVaultListProps) {
  return (
    <ul class="recent-vaults">
      <For each={props.vaults}>
        {(v) => (
          <li
            class="recent-vaults__row"
            classList={{ "recent-vaults__row--missing": !v.exists }}
          >
            <Show
              when={v.exists}
              fallback={
                <>
                  <span class="recent-vaults__name" title={v.path}>
                    {vaultName(v.path)}{" "}
                    <span class="recent-vaults__hint">(missing)</span>
                  </span>
                  <button
                    type="button"
                    class="recent-vaults__remove"
                    aria-label={`Remove ${vaultName(v.path)} from recent vaults`}
                    onClick={() => props.onRemove(v.path)}
                  >
                    ×
                  </button>
                </>
              }
            >
              <button
                type="button"
                class="recent-vaults__switch"
                title={v.path}
                onClick={() => props.onSwitch(v.path)}
              >
                {vaultName(v.path)}
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}
```

- [ ] **Step 2: Rewire `VaultSwitcher`** — in `ui/src/VaultSwitcher.tsx`, update the imports, the props interface, and the recents render:

Replace the import line (top) and props interface:

```tsx
import { Show, onCleanup, onMount } from "solid-js";

import { RecentVaultList } from "./RecentVaultList";
import type { RecentVault } from "./api/ipc";

export interface VaultSwitcherProps {
  currentPath: string | null;
  recentVaults?: RecentVault[];
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
  onOpenFolder: () => void;
  onDismiss: () => void;
}
```

Replace the `recents`/`<Show>`/`<ul>` block (the current lines 40 and 52-58) with:

```tsx
  const recents = () => props.recentVaults ?? [];
```

and, in the JSX where the `<Show when={recents().length > 0}>…</Show>` was:

```tsx
        <Show when={recents().length > 0}>
          <RecentVaultList
            vaults={recents()}
            onSwitch={(path) => {
              props.onDismiss();
              props.onSwitch(path);
            }}
            onRemove={(path) => props.onRemove(path)}
          />
        </Show>
```

Remove the now-unused local `vaultName` from `VaultSwitcher.tsx` only if it is no longer referenced (the "Current vault" line still uses it — keep it if so).

- [ ] **Step 3: Add styles** — append to `ui/src/styles/layout.css` (reuse the muted token `.set-info-pop`/`.vault-switcher` already use; grep to confirm the exact name, e.g. `--c-fg-muted`):

```css
.recent-vaults {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.recent-vaults__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.recent-vaults__switch {
  flex: 1;
  text-align: left;
}
.recent-vaults__row--missing .recent-vaults__name {
  color: var(--c-fg-muted);
}
.recent-vaults__hint {
  font-size: var(--text-xs);
  color: var(--c-fg-muted);
}
.recent-vaults__remove {
  color: var(--c-fg-muted);
}
```

- [ ] **Step 4: App imports** — add to `ui/src/App.tsx`:

```tsx
import { RecentVaultList } from "./RecentVaultList";
```

and extend the existing `./api/ipc` import to include `listRecentVaults`, `removeRecentVault`, and `type RecentVault`.

- [ ] **Step 5: Signal + refresh helper** — near the other UI signals (e.g. after the `busy` signal), add:

```tsx
  // Machine-local recent-vaults list (populated from the app-config store).
  const [recentVaults, setRecentVaults] = createSignal<RecentVault[]>([]);
  const refreshRecentVaults = async () => {
    try {
      const resp = await listRecentVaults();
      setRecentVaults(resp.vaults);
    } catch (e) {
      console.error("listRecentVaults failed", e);
      setRecentVaults([]);
    }
  };
```

- [ ] **Step 6: Refresh after opens** — at the end of `openVaultByPath`'s `try` block (right after the final `shortcuts.overrides` seed, before the `catch`), add:

```tsx
      void refreshRecentVaults();
```

- [ ] **Step 7: Launch auto-open** — at the END of the existing `onMount(async () => { … })` (the one at ~App.tsx:1259 that registers vault-scan listeners), after the listeners are registered, add:

```tsx
    // Recent vaults + auto-open the last one. Do this after the scan
    // listeners are wired so the auto-opened vault's progress events land.
    await refreshRecentVaults();
    const top = recentVaults()[0];
    if (top && top.exists) {
      void openVaultByPath(top.path);
    }
```

- [ ] **Step 8: Wire the VaultSwitcher call site** — find the `<VaultSwitcher … />` usage (App.tsx ~2108) and replace its props with:

```tsx
                    <VaultSwitcher
                      currentPath={vaultPath()}
                      recentVaults={recentVaults().filter(
                        (v) => v.path !== vaultPath(),
                      )}
                      onSwitch={(path) => void openVaultByPath(path)}
                      onRemove={(path) =>
                        void removeRecentVault({ path }).then(refreshRecentVaults)
                      }
                      onOpenFolder={() => void handleOpen()}
                      onDismiss={() => setVaultSwitcherOpen(false)}
                    />
```

- [ ] **Step 9: Add the recent list to the empty-vault landing** — replace the `.empty-vault` fallback block (`ui/src/App.tsx:1785-1795`) with:

```tsx
          <div class="empty-vault">
            <p>Pick a folder to open it as a vault.</p>
            <button
              type="button"
              class="chrome-btn chrome-btn--primary"
              onClick={handleOpen}
              disabled={busy()}
            >
              Open Vault
            </button>
            <Show when={recentVaults().length > 0}>
              <div class="empty-vault__recents">
                <p class="empty-vault__recents-label">Recent vaults</p>
                <RecentVaultList
                  vaults={recentVaults()}
                  onSwitch={(path) => void openVaultByPath(path)}
                  onRemove={(path) =>
                    void removeRecentVault({ path }).then(refreshRecentVaults)
                  }
                />
              </div>
            </Show>
          </div>
```

- [ ] **Step 10: Typecheck + test** — `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean, 728/728 (components are smoke-only; no test changes).

- [ ] **Step 11: Operator smoke** — `npm run tauri dev`:
  - Open vault A via the picker, then B, then C. Quit and relaunch → **C auto-opens** straight to notes.
  - Click the vault name → switcher lists A and B (not C, the current) → click A → switches to A.
  - Move/rename one recent's folder on disk, relaunch/reopen switcher → that entry is **greyed "(missing)"**; click its × → it disappears from the list.
  - With no vault open (fresh config or after pruning the top) → the **landing shows the recent list**; clicking one opens it.
  - "Open folder…" still opens the OS dialog and adds a new vault.

- [ ] **Step 12: Commit** (the whole frontend UI + wiring, one green commit)

```bash
git add ui/src/RecentVaultList.tsx ui/src/VaultSwitcher.tsx ui/src/styles/layout.css ui/src/App.tsx
git commit -m "feat(vault): recent-vaults list, switch, launch auto-open, landing recents

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Full gate: `bash scripts/check.sh` — fmt/clippy/test (Rust + the new `recent_vaults` tests), tsc, vitest, build, docs all green. (Note: a pre-existing Rust `watcher` timing test can flake under load — re-run in isolation if it trips; it's unrelated to this change.)
- [ ] Commits scoped one-per-task: `git log --oneline main..HEAD`.
- [ ] Update the CLAUDE.md Project state block and the `project_requested_ui_backlog` memory (recent-vaults store done → vault-switcher now has memory) at session close.
