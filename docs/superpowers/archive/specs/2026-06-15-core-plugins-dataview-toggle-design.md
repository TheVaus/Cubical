# Core Plugins toggle + TOML settings file (design)

**Date:** 2026-06-15
**Status:** approved (brainstorm), pending implementation plan
**Scope:** two phases, both in this build —
**Phase 1:** move per-vault settings out of the libSQL `config` table into
a single TOML file, `.cubical/config.toml`, which becomes the source of
truth.
**Phase 2:** the Dataview Core Plugin on/off toggle, the settings file's
first feature consumer.

---

## 1. Goal

1. **Settings live in a plain, portable TOML file.** `.cubical/config.toml`
   is the single source of truth for per-vault settings — human-readable,
   editable, and it travels with the vault.
2. **Toggle Dataview.** From **Settings → Plugins → Core Plugins**, turn
   the L4-D Dataview feature (live ```query blocks) on or off. When off,
   ```query blocks render as plain raw markdown.

"Core Plugins" = Obsidian-style **built-in, toggleable first-party
features** that ship in the binary. Distinct from the locked **L6
WASM/WASI community-plugin sandbox** (`planned.md` §8); nothing here
touches L6.

## 2. Decisions (from brainstorm)

- **Single store, no redundancy.** `.cubical/config.toml` (TOML) is the
  sole source of truth **for settings**; the DB `config` table no longer
  holds them (it is narrowed to workspace state — see §4.3). Accepted
  trade: deleting `.cubical/` resets settings to defaults — recoverable
  from backup/trash, and cheap to re-set by hand.
- **Location:** inside `.cubical/` (single hidden dir, clean vault root).
- **Format rationale (so nobody "fixes" the split later):** TOML is right
  for `config.toml` because it is *Cubical's own* file — no other tool
  reads it, so it optimizes for config ergonomics (comments, strict
  types, no whitespace footguns). Note **frontmatter stays YAML**: it
  lives in the user's portable `.md` files, which must stay standard
  Markdown that vim / Obsidian / Hugo / Pandoc all read. Different owners,
  different right formats — the inconsistency is intentional.
- **Access:** the file is parsed into an in-memory map on vault open;
  `get_setting` reads the map; `set_setting` updates the map and rewrites
  the file with an **atomic write** (temp + fsync + rename).
- **Lazy creation:** opening a vault never writes anything. The file is
  created only on the first `set_setting`. Until it exists, settings
  resolve to defaults.
- **External edits:** picked up at next vault open (the file is re-read
  then). No file-watching. An optional **"Reload settings from file"**
  action can re-read mid-session, but it is not core.
- **Settings vs workspace state.** `config.toml` holds **durable
  settings/preferences only** (theme, default editor mode, plugin
  enablement, flush interval). **Ephemeral workspace/UI state** — sidebar
  collapsed/active-panel, and later open tabs / scroll — is session
  layout, not a setting: it **never** goes in `config.toml`. It stays
  local in the DB (disposable cache, the correct home for resettable
  layout) and does not travel with the vault. Mirrors Obsidian's
  `app.json` (settings) vs `workspace.json` (layout) split.
- **Toggle:** extensible data-driven Core Plugins list, ships Dataview
  only; per-vault; **default enabled**; **live** gating via the
  runner-null path.

## 3. Architecture amendment (required, Phase 1)

Amend `docs/architecture/vault.md` §3. Today it says *everything in
`.cubical/` is rebuildable from the markdown*. `config.toml` is **not**
derivable from markdown, so the rule needs a carve-out:

> `.cubical/` holds vault-owned state in two categories:
> - **Durable config** — `config.toml`. The source of truth for the
>   user's settings; **not** rebuildable from markdown. Deleting it resets
>   settings to defaults (recoverable from a backup/trash copy).
> - **Rebuildable cache** — `index.db`, `search/`, `recovery/`, etc.
>   Derived from the markdown; safe to delete and regenerate.

A deliberate change to a locked rule; it is the gate for Phase 1.

## 4. Phase 1 — settings move to `.cubical/config.toml`

### 4.1 Format
Setting keys are dotted (`plugins.dataview_enabled`,
`appearance.theme_mode`); values are scalars (bool / string-enum /
number). Dotted keys map to TOML nested tables:
```toml
[appearance]
theme_mode = "dark"

[editor]
raw_source_default = false

[plugins]
dataview_enabled = true
```
A small Rust module owns `toml ⇄ in-memory settings map`, isolated and
unit-tested in a no-Tauri crate. Scalars use native TOML types; an
unknown/non-scalar value (forward-safety) round-trips through its JSON
string.

### 4.2 Store + access (replaces the DB `config` table)
- **Open:** if `config.toml` exists, parse it into the per-vault
  in-memory settings map; a parse error leaves the map empty and surfaces
  a non-fatal warning (never blocks open). Absent ⇒ empty map (defaults).
- **`get_setting`:** read from the in-memory map; absent key ⇒ the caller
  applies its default (frontend already treats absent as default).
- **`set_setting`:** update the map, then atomically rewrite the whole
  file from the map. First write creates the file (lazy).
- **(optional) `reload_settings { vault_id }`:** re-parse the file into
  the map and return the resolved settings, for picking up external edits
  mid-session.

### 4.3 Split the DB config table (settings out, workspace state stays)
- **Durable settings move out of the DB into `config.toml`.** The
  `appearance` / `editor` / `pending_rewrites` / `plugins` keys are served
  from the in-memory map (file-backed) — no longer from the DB.
- **Ephemeral workspace/UI state stays DB-backed.** `ui.right_sidebar_*`
  (and future layout state) remain in the local `config` table — it is
  disposable cache, the right home for resettable, non-portable layout.
  These keys are **never written to `config.toml`.**
- **Classify before moving:** the plan tags each existing setting key as
  *setting* (→ file) or *workspace state* (→ stays DB), and confirms no
  other subsystem reads the table. Pre-1.0 dev vaults start fresh; no data
  migration shipped.
- Net: the `config` table is **narrowed**, not dropped — it keeps only
  workspace/UI state going forward.

### 4.4 Tests
- TOML ⇄ map conversion: scalars, dotted-key nesting, round-trip,
  unknown-value passthrough, malformed-TOML error (pure unit tests).
- `open_vault`: file present hydrates the map; absent ⇒ defaults; malformed
  ⇒ empty map + warning, open still succeeds (integration, temp vault).
- `set_setting`: file created on first set (lazy); atomic rewrite reflects
  the map; survives a re-open (cubical-app test).

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

### 5.4 State + persistence (`App.tsx`)
- `Record<string, boolean>` enablement signal, hydrated per-vault on open
  (one `getSetting` per registry entry).
- Toggle handler updates the signal + `setSetting(...)` (now file-backed
  via Phase 1).

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
       → in-memory map update + atomic config.toml rewrite   (Phase 1)
  → Editor dataviewRunner prop flips (runner | null)
  → dataviewBlockField rebuilds → widgets or raw text
```

## 7. Out of scope

Community/WASM plugins, plugin permissions UI, enable-all/disable-all,
file-watching, a DB cache / redundant copy of settings, automatic
regeneration of a deleted settings file, and migrating existing DB-stored
settings (pre-1.0 vaults start fresh).
