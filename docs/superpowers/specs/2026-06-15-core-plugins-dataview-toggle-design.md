# Core Plugins toggle + portable config file (design)

**Date:** 2026-06-15
**Status:** approved (brainstorm), pending implementation plan
**Scope:** two phases, both in this build —
**Phase 1:** portable vault config file (`.cubical/config.toml`) synced
with the libSQL `config` table.
**Phase 2:** the Dataview Core Plugin on/off toggle, the config file's
first feature consumer.

---

## 1. Goal

1. **Settings travel with the vault.** A shareable/exportable
   `.cubical/config.toml` mirrors the per-vault settings so a copied vault
   carries what the user had configured (incl. which core plugins are on).
2. **Toggle Dataview.** From **Settings → Plugins → Core Plugins**, turn
   the L4-D Dataview feature (live ```query blocks) on or off. When off,
   ```query blocks render as plain raw markdown.

"Core Plugins" = Obsidian-style **built-in, toggleable first-party
features** that ship in the binary. Distinct from the locked **L6
WASM/WASI community-plugin sandbox** (`planned.md` §8); nothing here
touches L6.

## 2. Decisions (from brainstorm)

- **Config file:** `.cubical/config.toml`, **TOML**. Matches the location
  already penciled in `vault.md` and the single-hidden-dir norm
  (`.obsidian/`, `.vscode/`).
- **Source-of-truth model:** the **file is the durable record; the DB
  `config` table is a fast cache** the app reads from at runtime.
- **Sync (no file-watching):**
  - **DB → file:** write-through on every `set_setting`.
  - **File → DB:** only on **vault open** and on an explicit **"Reload
    settings from file"** action. The DB never reacts to the file on its
    own — no watcher, no echo-suppression, no live-conflict handling.
  - **Open precedence:** if the file exists, it wins (its contents load
    into the DB). A stale DB never clobbers the file, because DB → file
    happens only on a UI change.
  - **Lazy creation:** opening a vault never writes anything. File missing
    + DB empty ⇒ defaults, write nothing. File missing + DB has rows ⇒
    write the file from the DB on open. Only a real `set_setting` first
    creates the file.
- **Conflicts:** last-action-wins; no 3-way merge (settings are
  low-stakes).
- **Toggle:** extensible data-driven Core Plugins list, ships Dataview
  only; per-vault; **default enabled**; **live** gating via the
  runner-null path.

## 3. Architecture amendment (required, Phase 1)

Amend `docs/architecture/vault.md` §3. Today it says *everything in
`.cubical/` is rebuildable from the markdown*. That was never quite true
(config isn't derivable from markdown) and this feature makes the gap
load-bearing. New framing:

> `.cubical/` holds vault-owned state in two categories:
> - **Durable config** — `config.toml`. The portable record of the
>   user's settings; **not** rebuildable from markdown. Travels with the
>   vault when shared.
> - **Rebuildable cache** — `index.db`, `search/`, `recovery/`, etc.
>   Derived from the markdown; safe to delete and regenerate.

This is a deliberate change to a locked rule and is the gate for Phase 1.

## 4. Phase 1 — portable config file ↔ DB sync

### 4.1 Serialization
The `config` table is `key → JSON value`. Setting keys are dotted
(`plugins.dataview_enabled`, `appearance.theme_mode`), and values today
are scalars (bool / string-enum / number). Map to TOML via dotted keys →
nested tables:
```toml
[appearance]
theme_mode = "dark"

[plugins]
dataview_enabled = true
```
A small Rust module owns `config_table ⇄ toml` conversion, isolated and
unit-tested (lives in a no-Tauri crate so it tests without the app
harness). Non-scalar/unknown values round-trip through their JSON string
if they ever appear (forward-safety); scalars use native TOML types.

### 4.2 Open-time hydration (in `open_vault`)
- `config.toml` present ⇒ parse it, replace the `config` table contents
  with it (file wins).
- absent + table non-empty ⇒ write `config.toml` from the table.
- absent + table empty ⇒ do nothing (lazy).
- Parse error ⇒ leave the DB as-is, surface a non-fatal warning; never
  block vault open.

### 4.3 Write-through (in `set_setting`)
After writing the `config` table, (re)write `config.toml` from the full
table. First write creates the file. This is the only path that creates
or mutates the file outside open-time.

### 4.4 Reload command (new IPC)
`reload_settings { vault_id } -> { settings: [...] }` — re-reads
`config.toml`, replaces the `config` table, returns the resolved
settings so the UI can refresh its signals. Wired to a **"Reload settings
from file"** button in the settings modal (vault-level action).

### 4.5 Tests
- TOML ⇄ table conversion: scalars, dotted-key nesting, round-trip,
  unknown-value passthrough, malformed-TOML error (pure, unit-tested).
- `open_vault` hydration: the four cases in §4.2 (integration, over a
  temp vault).
- `set_setting` write-through: file created on first set; reflects the
  table after (cubical-app test).
- `reload_settings`: external edit to the file is picked up; returns it.

## 5. Phase 2 — Dataview Core Plugin toggle

### 5.1 Setting key
Add to the `Setting` union (`ui/src/api/ipc.ts`):
`{ key: "plugins.dataview_enabled"; value: boolean }`. Absent ⇒ `true`.

### 5.2 Registry — `ui/src/settings/corePlugins.ts` (new, pure)
```ts
export interface CorePlugin {
  id: string; name: string; description: string;
  settingKey: BooleanSettingKey; defaultEnabled: boolean;
}
export const CORE_PLUGINS: CorePlugin[] = [
  { id: "dataview", name: "Dataview",
    description: "Render ```query blocks as live tables, lists, and counts.",
    settingKey: "plugins.dataview_enabled", defaultEnabled: true },
];
export function corePluginEnabled(
  state: Record<string, boolean>, plugin: CorePlugin,
): boolean;   // stored value, else defaultEnabled
```
`BooleanSettingKey` = the boolean-valued subset of `Setting["key"]`.

### 5.3 Settings UI — new `"plugins"` tab (`App.tsx` settings modal)
- Extend `SettingsTab` with `"plugins"` + a nav item.
- Render a **"Core Plugins"** heading, mapping `CORE_PLUGINS` to toggle
  rows (name, description, switch — reusing the `raw_source_default`
  toggle pattern).
- The **"Reload settings from file"** button (§4.4) also lives in the
  settings modal (vault-level placement).

### 5.4 State + persistence (`App.tsx`)
- `Record<string, boolean>` enablement signal, hydrated per-vault on open
  (one `getSetting` per registry entry), refreshed after `reload_settings`.
- Toggle handler updates the signal + `setSetting(...)` (which now
  write-throughs to the file via Phase 1).

### 5.5 Editor gating
- `<Editor>`'s `dataviewRunner` prop becomes
  `corePluginEnabled(state, dataview) ? dataviewRunner() : null`.
- Off ⇒ field emits nothing ⇒ raw ```query text. The Editor already
  reconfigures the runner facet reactively, so the toggle is live both
  ways. Existing `dataviewRunner()?.invalidate()` call sites are
  unaffected (only the prop is gated).

### 5.6 Tests
- `corePlugins.ts`: `corePluginEnabled` resolution (vitest).
- Settings tab + editor gating: operator-smoke (Contract E).
- Existing dataview tests stay green (gating is additive).

## 6. Data flow (Phase 2 over Phase 1)

```
toggle in modal
  → enablement signal flips (live)
  → setSetting("plugins.dataview_enabled", v)
       → config table write + config.toml write-through   (Phase 1)
  → Editor dataviewRunner prop flips (runner | null)
  → dataviewBlockField rebuilds → widgets or raw text
```

## 7. Out of scope

Community/WASM plugins, plugin permissions UI, enable-all/disable-all,
live file-watching of `config.toml`, 3-way merge for config, and
migrating non-settings state into the file.
