> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Recent-vaults store — design

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan
**Follows on from:** the memory-less vault-switcher shipped in the small-wins batch ([`2026-07-08-small-wins-ui-batch-design.md`](2026-07-08-small-wins-ui-batch-design.md) §#3). That popup left a `recentVaults` prop as a forward-compat seam; this feature fills it.

## Problem

The vault-switcher we shipped is memory-less: "Switch vault" → a popup whose only action is "Open folder…" → the OS file navigator. That's one extra click to reach the same OS dialog, delivering nothing over the old direct button. The original #3 goal was to *replace* OS-navigator reliance with an in-app window. To do that the app must remember which vaults exist across sessions — Cubical's first piece of **global, non-vault state**.

## Non-goals / constraints

- This is **machine-local app-shell state**, not vault content and not portable config. It never touches any `.md` file or a vault's `.cubical/`. It does not violate the pristine-vault non-negotiables.
- It lives in the **`cubical-app` Tauri layer**, not `cubical-engine` — the engine stays vault-focused (per [[project_engine_transport_decoupling]]). A future CLI frontend, if it wants recents, gets its own equivalent; we don't build for that now (YAGNI).
- No new Tauri plugin: Rust reaches the OS app-config dir via Tauri's core `path()`.

## 1. Storage (Rust, `cubical-app`)

A new module `crates/cubical-app/src/recent_vaults.rs` owns a JSON file `recent_vaults.json` in the **OS app-config dir** (`app.path().app_config_dir()`).

- **On-disk schema:** a JSON array of `{ "path": String, "last_opened_unix": i64 }`, ordered most-recent-first, **capped at 10** (LRU: the 11th push evicts the oldest).
- **Module API** (pure over an injected file path — unit-testable with a temp file, no Tauri):
  - `load(path: &Path) -> Vec<RecentVaultEntry>` — parse; a missing or unparseable file yields `vec![]` (never an error).
  - `record(path: &Path, vault_path: &str, now_unix: i64)` — dedupe by `vault_path` (an existing entry moves to the top and updates its timestamp rather than duplicating), then truncate to 10, then atomic-write.
  - `remove(path: &Path, vault_path: &str)` — drop the matching entry, atomic-write.
  - `list_with_existence(path: &Path) -> Vec<RecentVault>` — `load` + stamp each entry with `exists: bool` (a `std::path::Path::exists()` check on `vault_path`). Does not mutate the file (a temporarily-missing vault is not auto-pruned — see error handling).
- **Atomic writes** reuse the temp-file + rename discipline of [`cubical-core/src/vault/atomic.rs`](../../../crates/cubical-core/src/vault/atomic.rs) (`atomic_write`), so a crash mid-write can't corrupt the list.
- **Corruption policy:** a malformed `recent_vaults.json` is treated as empty on load and silently overwritten on the next `record`/`remove`. No crash, no user-facing error — this is disposable state.

### IPC surface

DTOs added to the shared `api`/ipc types:

```
RecentVault { path: String, last_opened_unix: i64, exists: bool }
ListRecentVaultsResponse { vaults: Vec<RecentVault> }   // most-recent first
RemoveRecentVaultRequest { path: String }
```

Two new Tauri command shims in `cubical-app/src/lib.rs`:

- `list_recent_vaults() -> ListRecentVaultsResponse` — resolves the app-config dir, calls `recent_vaults::list_with_existence`.
- `remove_recent_vault(RemoveRecentVaultRequest)` — calls `recent_vaults::remove`.

**Recording folds into the existing `open_vault` shim** (`cubical-app/src/lib.rs:134`, which already takes `app: AppHandle` and `req: OpenVaultRequest`): after `commands::vault::open_vault(...)` returns `Ok`, call `recent_vaults::record(app_config_dir, &req.path, now)`. A failed open records nothing. This is the single source of truth — the frontend never calls an "add" command, so it can't forget.

## 2. Frontend data flow

- **Launch (`onMount`, App.tsx):** call `list_recent_vaults`.
  - If the list is non-empty and its **top entry `exists`** → auto-open it via `openVaultByPath` (see §3), skipping the dialog.
  - Otherwise → render the existing `.empty-vault` landing (App.tsx:1785), now augmented with the recent list.
  - Deliberately **not** cascading to an older vault when the top one is missing — the user lands on the list and chooses. (Matches the approved behavior: "last vault missing → show the switcher with the remaining recents.")
- **Switcher (`VaultSwitcher.tsx`, already has the `recentVaults` prop):** App passes the fetched list plus callbacks.
  - Click an existing recent → `openVaultByPath(entry.path)`, dismiss.
  - A `exists: false` entry renders **greyed** with a "missing" hint and a **×**; clicking × (or the row) calls `remove_recent_vault` then refreshes the list. It does not open.
  - "Open folder…" stays as the add-new fallback (existing dialog flow).
- **`.empty-vault` landing** renders the same recent list (same data + callbacks), so a returning user whose last vault vanished can one-click another.
- The list is **refreshed** after each successful open and after each remove (re-call `list_recent_vaults`), so ordering/existence stay current.

## 3. Frontend refactor: `openVaultByPath`

Today `handleOpen` (App.tsx:1470) couples the OS dialog to the open-and-reset logic (the ~30-line state reset + `openVault` + resolver/provider setup). Extract the by-path core into **`openVaultByPath(path: string)`**; `handleOpen` becomes "await the dialog, then call `openVaultByPath(picked)`." Three callers share the one path: the dialog flow, recent-list clicks, and launch auto-open. Behavior-preserving for the dialog flow; no logic duplicated.

## 4. Error handling

- **Missing folder** (deleted / moved / unmounted drive): `exists: false` → greyed + click-× to prune (never auto-removed, so an unmounted drive's vault survives a reconnect). Auto-open skips a missing top entry → lands on the list.
- **Corrupt store file:** treated as empty; overwritten next write.
- **`open_vault` failure** (path exists but isn't an openable vault): existing error handling in the open flow surfaces it; nothing is recorded (recording is gated on `Ok`).
- **App-config dir unavailable** (pathological): `list_recent_vaults` returns an empty list and `record`/`remove` become no-ops rather than failing the open — recents are a convenience, never a blocker to opening a vault.

## 5. Testing

- **Rust unit tests** (`recent_vaults.rs`, temp-file based, no Tauri):
  - `record` dedupes an existing path (moves to top, updates timestamp, no duplicate).
  - `record` caps at 10 and evicts the oldest.
  - recency ordering (most-recent first) after several records.
  - `remove` drops the matching entry and leaves others ordered.
  - `load` on a missing file and on a corrupt file both yield `vec![]`.
  - roundtrip (`record` → `load`) preserves paths + timestamps.
  - `list_with_existence` stamps `exists` correctly for a real temp dir vs. a bogus path, and does not mutate the file.
- **Frontend:** `openVaultByPath` extraction is behavior-preserving (operator smoke of the dialog flow). Auto-open-on-launch, the populated switcher (switch + greyed-prune), and the landing list are operator-smoke per conventions (Solid components are smoke-only; the list logic that would otherwise need testing lives in Rust).

## 6. Files touched

- Create: `crates/cubical-app/src/recent_vaults.rs` (+ tests) and register the module.
- Modify: `crates/cubical-app/src/lib.rs` — 2 new command shims, register both in the handler list, fold recording into the `open_vault` shim.
- Modify: the shared ipc DTO surface (Rust `api` types + the TS `api/ipc.ts` bindings) — add `RecentVault`, `ListRecentVaultsResponse`, `RemoveRecentVaultRequest` and the two command wrappers.
- Modify: `ui/src/App.tsx` — `openVaultByPath` extraction, launch auto-open, switcher/landing list wiring + refresh.
- Modify: `ui/src/VaultSwitcher.tsx` — render a populated list (switch + greyed-missing + × prune).
- Modify: `ui/src/styles/layout.css` — recent-list rows + greyed/missing state (reuse existing tokens).

## 7. Cross-cutting notes

- No `.md` / `.cubical/` touch; no engine change; no new plugin.
- One cohesive feature → one implementation plan.
- **Verification:** `scripts/check.sh` green (this feature adds Rust, so the Rust gate matters again), plus operator smoke: launch auto-opens last vault; switcher lists recents and switches on click; a missing vault greys and prunes; "Open folder…" still adds; landing shows recents when auto-open finds nothing.
