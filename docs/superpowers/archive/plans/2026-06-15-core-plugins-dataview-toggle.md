# Core Plugins toggle + TOML settings file — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-vault settings from the libSQL `config` table into a portable `.cubical/config.toml` file (durable source of truth), then add a Settings → Plugins → Core Plugins toggle that turns the Dataview ```query renderer on/off.

**Architecture:** Phase 1 — a pure `settings` module in `cubical-core` converts a dotted-key settings map ⇄ TOML and loads/saves `.cubical/config.toml` (atomic write, lazy creation). `OpenVault` holds the in-memory map; `get_setting`/`set_setting` route *settings* keys to the map+file and leave *workspace* keys (`ui.*`) in the DB. Phase 2 — a data-driven Core Plugins registry + a Plugins settings tab toggles `plugins.dataview_enabled`, which gates the editor's dataview runner (null runner ⇒ raw ```query text).

**Tech Stack:** Rust (cubical-core, cubical-app, libSQL, `toml` + `serde_json`), TypeScript/SolidJS (ui), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-15-core-plugins-dataview-toggle-design.md`

---

## File structure

**Phase 1 (Rust):**
- Create `crates/cubical-core/src/vault/settings.rs` — pure: `SettingsMap`, `from_toml`/`to_toml`, `is_workspace_key`, `settings_path`, `load`, `save`. One responsibility: the settings file ⇄ map boundary.
- Modify `crates/cubical-core/src/vault/mod.rs` — `mod settings;` + re-export.
- Modify `crates/cubical-core/Cargo.toml` — add `toml`.
- Modify `crates/cubical-app/src/state.rs` — `OpenVault` gains `settings: Arc<RwLock<SettingsMap>>`.
- Modify `crates/cubical-app/src/commands/vault.rs` — `open_vault` hydrates the map; `get_setting`/`set_setting` route by key class; add `reload_settings`.
- Modify `crates/cubical-app/src/api/types.rs` — `ReloadSettingsRequest`/`Response`.
- Modify `crates/cubical-app/src/lib.rs` — register `reload_settings`.
- Modify `docs/architecture/vault.md` — the durable-config amendment.

**Phase 2 (TS):**
- Create `ui/src/settings/corePlugins.ts` (+ `.test.ts`) — registry + `corePluginEnabled`.
- Modify `ui/src/api/ipc.ts` — add `plugins.dataview_enabled` to `Setting`; add `reloadSettings` wrapper.
- Modify `ui/src/App.tsx` — enablement signal, `"plugins"` tab, gating of the `dataviewRunner` prop.

---

# Phase 1 — settings move to `.cubical/config.toml`

### Task 1.1: Add the `toml` dependency

**Files:**
- Modify: `crates/cubical-core/Cargo.toml`

- [ ] **Step 1: Add the dependency**

In `crates/cubical-core/Cargo.toml`, under `[dependencies]`, add:

```toml
toml = "0.8"
```

- [ ] **Step 2: Verify it resolves**

Run: `cargo build -p cubical-core`
Expected: builds clean (downloads `toml`).

- [ ] **Step 3: Commit**

```bash
git add crates/cubical-core/Cargo.toml Cargo.lock
git commit -m "build(core): add toml dependency for the settings file"
```

---

### Task 1.2: `SettingsMap` + `to_toml` (map → nested-table TOML)

**Files:**
- Create: `crates/cubical-core/src/vault/settings.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs`
- Test: in `settings.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Wire the module**

In `crates/cubical-core/src/vault/mod.rs`, add near the other `mod` lines:

```rust
pub mod settings;
```

- [ ] **Step 2: Write the failing test**

Create `crates/cubical-core/src/vault/settings.rs`:

```rust
//! The `.cubical/config.toml` settings file ⇄ in-memory map boundary.
//!
//! Settings are a flat map of dotted keys (`appearance.theme_mode`) to
//! JSON scalar values, mirroring the IPC shape. On disk they become
//! nested TOML tables. This module is pure + no-Tauri; the app layer owns
//! the in-memory copy and the IPC.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use super::VaultError;

/// Flat settings map: dotted key → JSON scalar value.
pub type SettingsMap = BTreeMap<String, Json>;

/// Serialize a flat dotted-key map to TOML with nested tables.
/// `{"appearance.theme_mode": "dark"}` → `[appearance]\ntheme_mode = "dark"`.
pub fn to_toml(map: &SettingsMap) -> Result<String, VaultError> {
    let mut root = toml::value::Table::new();
    for (dotted, json) in map {
        insert_dotted(&mut root, dotted, json_to_toml(json));
    }
    toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|e| VaultError::Settings(format!("encode TOML: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_toml_nests_dotted_keys() {
        let mut m = SettingsMap::new();
        m.insert("appearance.theme_mode".into(), json!("dark"));
        m.insert("plugins.dataview_enabled".into(), json!(true));
        let out = to_toml(&m).unwrap();
        assert!(out.contains("[appearance]"));
        assert!(out.contains("theme_mode = \"dark\""));
        assert!(out.contains("[plugins]"));
        assert!(out.contains("dataview_enabled = true"));
    }
}
```

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `cargo test -p cubical-core settings::`
Expected: FAIL — `insert_dotted`, `json_to_toml`, `VaultError::Settings` not defined.

- [ ] **Step 4: Add the `VaultError::Settings` variant**

In `crates/cubical-core/src/vault/mod.rs`, find `pub enum VaultError` and add a variant (match the existing `#[error(...)]` style):

```rust
    #[error("settings file error: {0}")]
    Settings(String),
```

- [ ] **Step 5: Implement the helpers**

Append to `settings.rs` (above `#[cfg(test)]`):

```rust
/// Convert a JSON scalar to a TOML value. Non-scalar / unrepresentable
/// values fall back to their JSON string (forward-safety).
fn json_to_toml(v: &Json) -> toml::Value {
    match v {
        Json::Bool(b) => toml::Value::Boolean(*b),
        Json::Number(n) if n.is_i64() => toml::Value::Integer(n.as_i64().unwrap()),
        Json::Number(n) => toml::Value::Float(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => toml::Value::String(s.clone()),
        other => toml::Value::String(other.to_string()),
    }
}

/// Insert `value` at a dotted path into a TOML table, creating sub-tables.
fn insert_dotted(table: &mut toml::value::Table, dotted: &str, value: toml::Value) {
    let mut parts = dotted.split('.').peekable();
    let mut cur = table;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            cur.insert(part.to_string(), value);
            return;
        }
        let entry = cur
            .entry(part.to_string())
            .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
        if !entry.is_table() {
            *entry = toml::Value::Table(toml::value::Table::new());
        }
        cur = entry.as_table_mut().unwrap();
    }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p cubical-core settings::`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-core/src/vault/settings.rs crates/cubical-core/src/vault/mod.rs
git commit -m "feat(core): settings map → nested-table TOML serialization"
```

---

### Task 1.3: `from_toml` (TOML → flat map)

**Files:**
- Modify: `crates/cubical-core/src/vault/settings.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `settings.rs`:

```rust
    #[test]
    fn from_toml_flattens_to_dotted_keys() {
        let src = "[appearance]\ntheme_mode = \"dark\"\n\n[plugins]\ndataview_enabled = true\n";
        let m = from_toml(src).unwrap();
        assert_eq!(m.get("appearance.theme_mode"), Some(&json!("dark")));
        assert_eq!(m.get("plugins.dataview_enabled"), Some(&json!(true)));
    }

    #[test]
    fn from_toml_round_trips_scalars() {
        let mut m = SettingsMap::new();
        m.insert("editor.raw_source_default".into(), json!(false));
        m.insert("pending_rewrites.flush_interval_secs".into(), json!(30));
        let back = from_toml(&to_toml(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn from_toml_rejects_malformed() {
        assert!(from_toml("not = = valid").is_err());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-core settings::`
Expected: FAIL — `from_toml` not defined.

- [ ] **Step 3: Implement `from_toml`**

Add to `settings.rs` (above `#[cfg(test)]`):

```rust
/// Parse TOML into a flat dotted-key settings map.
pub fn from_toml(src: &str) -> Result<SettingsMap, VaultError> {
    let value: toml::Value =
        toml::from_str(src).map_err(|e| VaultError::Settings(format!("parse TOML: {e}")))?;
    let mut out = SettingsMap::new();
    if let toml::Value::Table(t) = value {
        flatten(&t, String::new(), &mut out);
    }
    Ok(out)
}

/// Convert a TOML scalar to a JSON value (inverse of `json_to_toml`).
fn toml_to_json(v: &toml::Value) -> Json {
    match v {
        toml::Value::Boolean(b) => Json::Bool(*b),
        toml::Value::Integer(i) => Json::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        toml::Value::String(s) => Json::String(s.clone()),
        other => Json::String(other.to_string()),
    }
}

/// Recursively flatten nested tables into dotted keys.
fn flatten(table: &toml::value::Table, prefix: String, out: &mut SettingsMap) {
    for (k, v) in table {
        let key = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        match v {
            toml::Value::Table(t) => flatten(t, key, out),
            scalar => {
                out.insert(key, toml_to_json(scalar));
            }
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p cubical-core settings::`
Expected: PASS (all 4 settings tests).

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-core/src/vault/settings.rs
git commit -m "feat(core): TOML → flat settings map parsing + round-trip"
```

---

### Task 1.4: `settings_path` + `load` + `save` (file I/O, atomic, lazy)

**Files:**
- Modify: `crates/cubical-core/src/vault/settings.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module (uses `tempfile`, already a dev-dependency in this crate per other vault tests):

```rust
    #[test]
    fn load_missing_file_is_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_creates_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut m = SettingsMap::new();
        m.insert("plugins.dataview_enabled".into(), json!(false));
        save(dir.path(), &m).unwrap();
        assert!(settings_path(dir.path()).exists());
        assert_eq!(load(dir.path()).unwrap(), m);
    }

    #[test]
    fn load_malformed_file_errors() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(".cubical")).unwrap();
        std::fs::write(settings_path(dir.path()), "not = = valid").unwrap();
        assert!(load(dir.path()).is_err());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-core settings::`
Expected: FAIL — `load`, `save`, `settings_path` not defined.

- [ ] **Step 3: Implement file I/O**

Add to `settings.rs` (above `#[cfg(test)]`). Reuse `super::atomic::atomic_write`:

```rust
/// `<vault_root>/.cubical/config.toml`.
pub fn settings_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".cubical").join("config.toml")
}

/// Load settings from the file. A missing file ⇒ empty map (defaults).
/// A present-but-malformed file is an error (callers keep prior state).
pub fn load(vault_root: &Path) -> Result<SettingsMap, VaultError> {
    let path = settings_path(vault_root);
    match std::fs::read_to_string(&path) {
        Ok(src) => from_toml(&src),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SettingsMap::new()),
        Err(e) => Err(VaultError::Settings(format!("read {}: {e}", path.display()))),
    }
}

/// Atomically write the settings map to the file, creating `.cubical/`.
pub fn save(vault_root: &Path, map: &SettingsMap) -> Result<(), VaultError> {
    let path = settings_path(vault_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| VaultError::Settings(format!("mkdir {}: {e}", parent.display())))?;
    }
    let toml = to_toml(map)?;
    super::atomic::atomic_write(&path, toml.as_bytes())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p cubical-core settings::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-core/src/vault/settings.rs
git commit -m "feat(core): load/save .cubical/config.toml (atomic, lazy, missing-ok)"
```

---

### Task 1.5: `is_workspace_key` (settings vs workspace classification)

**Files:**
- Modify: `crates/cubical-core/src/vault/settings.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn ui_keys_are_workspace_state_others_are_settings() {
        assert!(is_workspace_key("ui.right_sidebar_collapsed"));
        assert!(is_workspace_key("ui.right_sidebar_panel"));
        assert!(!is_workspace_key("appearance.theme_mode"));
        assert!(!is_workspace_key("plugins.dataview_enabled"));
        assert!(!is_workspace_key("editor.raw_source_default"));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-core settings::`
Expected: FAIL — `is_workspace_key` not defined.

- [ ] **Step 3: Implement**

Add to `settings.rs`:

```rust
/// Workspace/UI state (transient session layout) lives in the DB, never in
/// `config.toml`. Everything under the `ui.` namespace is workspace state;
/// all other keys are durable settings.
pub fn is_workspace_key(key: &str) -> bool {
    key.starts_with("ui.")
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p cubical-core settings::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-core/src/vault/settings.rs
git commit -m "feat(core): classify settings vs ui.* workspace keys"
```

---

### Task 1.6: `OpenVault` holds the in-memory settings map; `open_vault` hydrates it

**Files:**
- Modify: `crates/cubical-app/src/state.rs` (`OpenVault` struct + `OpenVault::new`)
- Modify: `crates/cubical-app/src/commands/vault.rs` (`open_vault`)

- [ ] **Step 1: Add the field to `OpenVault`**

In `crates/cubical-app/src/state.rs`, add the import and a field on `struct OpenVault`:

```rust
use std::sync::Arc;
use tokio::sync::RwLock;
use cubical_core::vault::settings::SettingsMap;
```

Add to the struct (next to `pub vault: Vault`):

```rust
    /// In-memory copy of the durable settings (`.cubical/config.toml`),
    /// the source of truth for non-`ui.*` keys. Workspace `ui.*` state
    /// stays in the DB `config` table.
    pub settings: Arc<RwLock<SettingsMap>>,
```

Add a `settings: SettingsMap` parameter to `OpenVault::new(...)` and set `settings: Arc::new(RwLock::new(settings))` in the constructed value. (Follow the existing parameter/field ordering in `new`.)

- [ ] **Step 2: Build to find all `OpenVault::new` callers**

Run: `cargo build -p cubical-app 2>&1 | grep -A2 "OpenVault::new"`
Expected: a compile error at the `open_vault` call site (and any test builders) — these are fixed next.

- [ ] **Step 3: Hydrate in `open_vault`**

In `crates/cubical-app/src/commands/vault.rs`, in `open_vault`, after `let vault = Vault::open(&req.path).await?;` and before constructing `OpenVault`, load the settings:

```rust
    // Durable settings live in <vault>/.cubical/config.toml (source of
    // truth). A missing file ⇒ defaults; a malformed file ⇒ start empty
    // and log (never block open).
    let settings = cubical_core::vault::settings::load(vault.root()).unwrap_or_else(|e| {
        tracing::warn!("settings load failed, using defaults: {e}");
        cubical_core::vault::settings::SettingsMap::new()
    });
```

Pass `settings` into `OpenVault::new(...)` at that call site.

- [ ] **Step 4: Fix any other `OpenVault::new` callers**

Run: `cargo build -p cubical-app 2>&1 | grep -B1 -A3 error`
For each remaining caller (e.g. test helpers), pass `cubical_core::vault::settings::SettingsMap::new()` for the new parameter.

- [ ] **Step 5: Verify build + existing tests**

Run: `cargo test -p cubical-app 2>&1 | tail -5`
Expected: builds; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/state.rs crates/cubical-app/src/commands/vault.rs
git commit -m "feat(app): OpenVault holds settings map; open_vault hydrates from config.toml"
```

---

### Task 1.7: Route `get_setting` (settings → map, workspace → DB)

**Files:**
- Modify: `crates/cubical-app/src/commands/vault.rs` (`get_setting` + its tests)

- [ ] **Step 1: Write the failing test**

In the `tests` module of `vault.rs`, add (follow the existing `set_then_get_setting_round_trips_boolean` test for harness setup — `open_test_vault()` or equivalent helper):

```rust
    #[tokio::test]
    async fn settings_key_reads_from_the_file_backed_map() {
        let (state, vault_id) = open_test_vault().await;
        set_setting(&state, SetSettingRequest {
            vault_id: vault_id.clone(),
            key: "plugins.dataview_enabled".into(),
            value: serde_json::json!(false),
        }).await.unwrap();
        let got = get_setting(&state, GetSettingRequest {
            vault_id, key: "plugins.dataview_enabled".into(),
        }).await.unwrap();
        assert_eq!(got.value, Some(serde_json::json!(false)));
    }
```

(If no shared `open_test_vault` helper exists, copy the setup from the nearest existing `#[tokio::test]` setting test verbatim.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-app settings_key_reads_from_the_file_backed_map`
Expected: FAIL — `set_setting` still writes the DB; `get_setting` reads the DB, returns `None`.

- [ ] **Step 3: Route `get_setting`**

In `get_setting`, after resolving `open`, branch before the DB query:

```rust
    if !cubical_core::vault::settings::is_workspace_key(&req.key) {
        let map = open.settings.read().await;
        return Ok(GetSettingResponse { value: map.get(&req.key).cloned() });
    }
    // workspace (`ui.*`) keys fall through to the DB read below.
```

(Leave the existing DB read for the workspace path.)

- [ ] **Step 4: Run (will still fail until set_setting is routed — that's Task 1.8)**

Run: `cargo test -p cubical-app settings_key_reads_from_the_file_backed_map`
Expected: still FAIL (set_setting writes the DB, not the map). Proceed to Task 1.8; this test passes there.

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-app/src/commands/vault.rs
git commit -m "feat(app): get_setting reads settings keys from the file-backed map"
```

---

### Task 1.8: Route `set_setting` (settings → map+file, workspace → DB)

**Files:**
- Modify: `crates/cubical-app/src/commands/vault.rs` (`set_setting`)

- [ ] **Step 1: Route `set_setting`**

In `set_setting`, after resolving `open`, branch before the DB upsert:

```rust
    if !cubical_core::vault::settings::is_workspace_key(&req.key) {
        let mut map = open.settings.write().await;
        map.insert(req.key.clone(), req.value.clone());
        cubical_core::vault::settings::save(open.vault.root(), &map)
            .map_err(|e| CubicalError::InvalidRequest(format!("save settings: {e}")))?;
        return Ok(SetSettingResponse {});
    }
    // workspace (`ui.*`) keys fall through to the DB upsert below.
```

- [ ] **Step 2: Run the Task 1.7 test — now passes**

Run: `cargo test -p cubical-app settings_key_reads_from_the_file_backed_map`
Expected: PASS.

- [ ] **Step 3: Add a lazy-creation + workspace-still-DB test**

Add to the `tests` module:

```rust
    #[tokio::test]
    async fn first_settings_write_creates_the_file_and_workspace_stays_in_db() {
        let (state, vault_id) = open_test_vault().await;
        let root = {
            let g = state.vaults().read().await;
            g.get(&vault_id).unwrap().vault.root().to_path_buf()
        };
        let cfg = cubical_core::vault::settings::settings_path(&root);
        assert!(!cfg.exists(), "no file before any settings change (lazy)");

        set_setting(&state, SetSettingRequest {
            vault_id: vault_id.clone(), key: "editor.raw_source_default".into(),
            value: serde_json::json!(true),
        }).await.unwrap();
        assert!(cfg.exists(), "settings write creates config.toml");

        // A ui.* workspace key must NOT land in the file.
        set_setting(&state, SetSettingRequest {
            vault_id, key: "ui.right_sidebar_collapsed".into(),
            value: serde_json::json!(true),
        }).await.unwrap();
        let on_disk = std::fs::read_to_string(&cfg).unwrap();
        assert!(!on_disk.contains("right_sidebar"), "workspace state stays in the DB");
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p cubical-app first_settings_write_creates_the_file_and_workspace_stays_in_db`
Expected: PASS.

- [ ] **Step 5: Full app suite**

Run: `cargo test -p cubical-app 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/commands/vault.rs
git commit -m "feat(app): set_setting writes settings to config.toml; ui.* stays in DB"
```

---

### Task 1.9: `reload_settings` IPC (pick up external file edits)

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`
- Modify: `crates/cubical-app/src/commands/vault.rs`
- Modify: `crates/cubical-app/src/lib.rs`

- [ ] **Step 1: Add request/response types**

In `api/types.rs`, mirroring the other vault-keyed request structs:

```rust
#[derive(Debug, serde::Deserialize)]
pub struct ReloadSettingsRequest {
    pub vault_id: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ReloadSettingsResponse {
    /// All durable settings after re-reading the file: dotted key → value.
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
}
```

- [ ] **Step 2: Write the failing test**

In `vault.rs` tests:

```rust
    #[tokio::test]
    async fn reload_settings_picks_up_an_external_file_edit() {
        let (state, vault_id) = open_test_vault().await;
        let root = {
            let g = state.vaults().read().await;
            g.get(&vault_id).unwrap().vault.root().to_path_buf()
        };
        // Write the file directly (as an external editor would).
        let mut m = cubical_core::vault::settings::SettingsMap::new();
        m.insert("appearance.theme_mode".into(), serde_json::json!("light"));
        cubical_core::vault::settings::save(&root, &m).unwrap();

        let resp = reload_settings(&state, ReloadSettingsRequest { vault_id: vault_id.clone() })
            .await.unwrap();
        assert_eq!(resp.settings.get("appearance.theme_mode"), Some(&serde_json::json!("light")));
        // And the in-memory map now serves it.
        let got = get_setting(&state, GetSettingRequest {
            vault_id, key: "appearance.theme_mode".into(),
        }).await.unwrap();
        assert_eq!(got.value, Some(serde_json::json!("light")));
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p cubical-app reload_settings_picks_up_an_external_file_edit`
Expected: FAIL — `reload_settings` not defined.

- [ ] **Step 4: Implement `reload_settings`**

In `vault.rs`:

```rust
/// Re-read `.cubical/config.toml` into the in-memory map (the file is the
/// source of truth) and return the resolved settings. For picking up edits
/// made to the file outside Cubical.
pub async fn reload_settings(
    state: &AppState,
    req: ReloadSettingsRequest,
) -> Result<ReloadSettingsResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let fresh = cubical_core::vault::settings::load(open.vault.root())
        .map_err(|e| CubicalError::InvalidRequest(format!("reload settings: {e}")))?;
    *open.settings.write().await = fresh.clone();
    Ok(ReloadSettingsResponse { settings: fresh })
}
```

Add the imports for `ReloadSettingsRequest`/`Response` to the `use` block at the top of `vault.rs`.

- [ ] **Step 5: Register the Tauri command**

In `crates/cubical-app/src/lib.rs`, add a shim next to the other vault command shims (follow the `dataview_query` shim shape) and add `reload_settings` to the `invoke_handler![...]` list.

- [ ] **Step 6: Run the test + full suite**

Run: `cargo test -p cubical-app reload_settings_picks_up_an_external_file_edit && cargo test -p cubical-app 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-app/src/api/types.rs crates/cubical-app/src/commands/vault.rs crates/cubical-app/src/lib.rs
git commit -m "feat(app): reload_settings IPC re-reads config.toml into the map"
```

---

### Task 1.10: Architecture amendment + Phase 1 gates

**Files:**
- Modify: `docs/architecture/vault.md`

- [ ] **Step 1: Amend the rule**

In `docs/architecture/vault.md` §3, replace the paragraph stating *everything in `.cubical/` is rebuildable* with the two-category framing from the spec §3 (durable config `config.toml` vs rebuildable cache). Keep wording tight.

- [ ] **Step 2: Run all Rust gates**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/vault.md
git commit -m "docs(arch): .cubical/ holds durable config.toml + rebuildable cache"
```

---

# Phase 2 — Dataview Core Plugin toggle

### Task 2.1: Add the setting key to the `Setting` union

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Extend the union**

In `ui/src/api/ipc.ts`, add to the `Setting` union (after the existing members, ~line 259):

```ts
  | { key: "plugins.dataview_enabled"; value: boolean }
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(ui): add plugins.dataview_enabled setting key"
```

---

### Task 2.2: Core Plugins registry (`corePlugins.ts`) — TDD

**Files:**
- Create: `ui/src/settings/corePlugins.ts`
- Test: `ui/src/settings/corePlugins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/settings/corePlugins.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { CORE_PLUGINS, corePluginEnabled } from "./corePlugins";

const dataview = CORE_PLUGINS.find((p) => p.id === "dataview")!;

describe("corePluginEnabled", () => {
  test("uses the stored value when present", () => {
    expect(corePluginEnabled({ dataview: false }, dataview)).toBe(false);
    expect(corePluginEnabled({ dataview: true }, dataview)).toBe(true);
  });
  test("falls back to defaultEnabled when absent", () => {
    expect(corePluginEnabled({}, dataview)).toBe(dataview.defaultEnabled);
  });
});

describe("CORE_PLUGINS", () => {
  test("ships the dataview entry, default-on", () => {
    expect(dataview.settingKey).toBe("plugins.dataview_enabled");
    expect(dataview.defaultEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/settings/corePlugins.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `ui/src/settings/corePlugins.ts`:

```ts
import type { Setting } from "../api/ipc";

/** Setting keys whose value is a boolean — the only keys a toggle can bind. */
export type BooleanSettingKey = Extract<Setting, { value: boolean }>["key"];

export interface CorePlugin {
  /** Stable id, also the enablement-map key. */
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultEnabled: boolean;
}

export const CORE_PLUGINS: CorePlugin[] = [
  {
    id: "dataview",
    name: "Dataview",
    description: "Render ```query blocks as live tables, lists, and counts.",
    settingKey: "plugins.dataview_enabled",
    defaultEnabled: true,
  },
];

/** Resolve a plugin's on/off state: the stored value, else its default. */
export function corePluginEnabled(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean {
  return state[plugin.id] ?? plugin.defaultEnabled;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/settings/corePlugins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/corePlugins.ts ui/src/settings/corePlugins.test.ts
git commit -m "feat(ui): core plugins registry + corePluginEnabled"
```

---

### Task 2.3: Enablement signal + hydrate on vault open

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the signal + importer**

Near the other settings signals in `App.tsx`, add:

```ts
import { CORE_PLUGINS, corePluginEnabled } from "./settings/corePlugins";
// ...
const [corePlugins, setCorePlugins] = createSignal<Record<string, boolean>>({});
```

- [ ] **Step 2: Hydrate on open**

In the vault-open handler (next to the `appearance.theme_mode` load, ~App.tsx:1128), add:

```ts
      // Load each core plugin's enablement (absent ⇒ default).
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
```

- [ ] **Step 3: Typecheck + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): hydrate core-plugin enablement on vault open"
```

---

### Task 2.4: Plugins settings tab + toggle handler

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Extend `SettingsTab` + nav**

In `App.tsx`, change the `SettingsTab` type (~line 262) to include `"plugins"`:

```ts
  type SettingsTab = "appearance" | "editor" | "plugins" | "vault" | "shortcuts";
```

Add to the tab nav `<For each={[...]}>` list (the array at ~line 1707):

```ts
                    { id: "plugins", label: "🧩 Plugins" },
```

- [ ] **Step 2: Add the setter handler**

Near the other setting handlers (e.g. the `raw_source_default` toggle, ~line 681). Use an explicit setter (the UI is an idempotent Off/On segmented control, matching the existing `raw_source_default` row):

```ts
  const setCorePlugin = (
    id: string,
    settingKey: BooleanSettingKey,
    value: boolean,
  ) => {
    const v = vaultId();
    if (!v) return;
    setCorePlugins((prev) => ({ ...prev, [id]: value }));
    setSetting(v, settingKey, value).catch((e) => {
      console.error(`saving ${settingKey} failed`, e);
    });
  };
```

Add `BooleanSettingKey` to the `./settings/corePlugins` import.

- [ ] **Step 3: Add the tab body**

In the modal body, after the existing `<Show when={settingsTab() === "editor"}>` block, add. This mirrors the Editor tab's `raw_source_default` row exactly — `.set-row` + a `.seg-control` Off/On pair (App.tsx ~1759-1785):

```tsx
              <Show when={settingsTab() === "plugins"}>
                <h2 class="modal__h2">Core Plugins</h2>
                <For each={CORE_PLUGINS}>
                  {(p) => {
                    const on = () => corePlugins()[p.id] ?? p.defaultEnabled;
                    return (
                      <div class="set-row">
                        <div>
                          <div class="set-row__lab">{p.name}</div>
                          <div class="set-row__desc">{p.description}</div>
                        </div>
                        <div class="seg-control">
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": !on() }}
                            onClick={() => setCorePlugin(p.id, p.settingKey, false)}
                          >
                            Off
                          </button>
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": on() }}
                            onClick={() => setCorePlugin(p.id, p.settingKey, true)}
                          >
                            On
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
```

- [ ] **Step 4: Typecheck + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): Plugins settings tab with Core Plugins toggles"
```

---

### Task 2.5: Gate the editor's dataview runner on the toggle

**Files:**
- Modify: `ui/src/App.tsx` (the `<Editor dataviewRunner=... />` prop, ~line 1587)

- [ ] **Step 1: Gate the prop**

Change the `dataviewRunner` prop passed to `<Editor>` from `dataviewRunner()` to:

```tsx
                  dataviewRunner={
                    corePluginEnabled(corePlugins(), CORE_PLUGINS[0])
                      ? dataviewRunner()
                      : null
                  }
```

(`CORE_PLUGINS[0]` is the Dataview entry; or `CORE_PLUGINS.find(p => p.id === "dataview")`.)

- [ ] **Step 2: Typecheck + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean. When disabled, the editor field gets a null runner ⇒ ```query blocks render as raw text; the toggle is live because the prop is reactive.

- [ ] **Step 3: Run the full vitest suite**

Run: `cd ui && npx vitest run 2>&1 | tail -5`
Expected: all pass (existing dataview tests unaffected; gating is additive).

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): gate dataview rendering on the Dataview core-plugin toggle"
```

---

### Task 2.6: Full gates + operator smoke note

**Files:** none (verification)

- [ ] **Step 1: Run all six gates**

Run:
```bash
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: all green.

- [ ] **Step 2: Operator smoke (Contract E — record, don't block)**

In `cargo tauri dev`, open the L4 smoke vault, then:
- Settings → Plugins → toggle Dataview **off** ⇒ open `Dashboard.md`; the three ```query blocks show as raw text immediately.
- Toggle **on** ⇒ they render again, live.
- Reopen the vault ⇒ the toggle state persisted (check `.cubical/config.toml` contains `[plugins]\ndataview_enabled = ...`).
- Confirm `ui.right_sidebar_*` is **not** in `config.toml`.

- [ ] **Step 3: Final commit (if any doc/record updates)**

```bash
git add -A && git commit -m "chore(core-plugins): record operator smoke for the dataview toggle"
```

---

## Self-review notes

- **Spec coverage:** Phase 1 §4.1 (TOML conv → 1.2/1.3), §4.2 (load/access → 1.4/1.6/1.7), §4.3 (split/classify → 1.5/1.7/1.8), reload §4.4 (→ 1.9), amendment §3 (→ 1.10). Phase 2 §5.1 (→ 2.1), §5.2 (→ 2.2), §5.3 (→ 2.4), §5.4 (→ 2.3), §5.5 (→ 2.5). Tests §4.4/§5.6 covered per task.
- **Type consistency:** `SettingsMap = BTreeMap<String, serde_json::Value>` used in core + app + the reload response. `BooleanSettingKey` defined once in `corePlugins.ts`, imported where used. `corePluginEnabled(state, plugin)` signature identical across tasks.
- **Open follow-on (not this plan):** typed Properties (planned.md §14); the optional reload-button UI can be added later wired to `reloadSettings`.
