# Core Plugins — Dataview toggle (design)

**Date:** 2026-06-15
**Status:** approved (brainstorm), pending implementation plan
**Buildable unit:** the Dataview on/off toggle. The portable config-sync
subsystem (§6) is a recorded *planned successor*, not part of this build.

---

## 1. Goal

Let the user turn the L4-D Dataview feature (live ```query blocks) on or
off from **Settings → Plugins → Core Plugins**. When off, ```query fenced
blocks render as plain raw markdown text — the feature simply isn't there.

"Core Plugins" here means Obsidian-style **built-in, toggleable
first-party features** that ship in the binary. This is distinct from the
locked **L6 WASM/WASI community-plugin sandbox** (`planned.md` §8): core
plugins are native TS/Rust, not sandboxed wasm. Dataview stays native; it
just becomes toggleable. No L6 surface is introduced here.

## 2. Decisions (from brainstorm)

- **Scope:** an extensible, data-driven Core Plugins list; ship Dataview
  as its only entry. Adding a future core plugin is one array entry.
- **Default:** enabled (absent setting ⇒ on). Preserves today's behaviour.
- **Storage:** per-vault, via the existing `set_setting`/`get_setting`
  IPC (libSQL `config` table). No Rust change — the store is generic
  key→JSON.
- **Reactivity:** live. Toggling re-renders open editors immediately,
  both directions.
- **Gating mechanism:** reuse the runner-null path. The dataview field
  already emits no decorations when the editor has no runner, so
  "disabled" = pass `null` as the runner. No CodeMirror compartment
  surgery.

## 3. Components

### 3.1 Setting key
Add to the typed `Setting` union in `ui/src/api/ipc.ts`:
```ts
| { key: "plugins.dataview_enabled"; value: boolean }
```
Absent ⇒ treated as `true`.

### 3.2 Core Plugins registry — `ui/src/settings/corePlugins.ts` (new, pure)
```ts
export interface CorePlugin {
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;   // a Setting key whose value is boolean
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

/** Resolve a plugin's effective on/off state: stored value, else default. */
export function corePluginEnabled(
  state: Record<string, boolean>,
  plugin: CorePlugin,
): boolean;
```
`BooleanSettingKey` = the subset of `Setting["key"]` whose value is
`boolean`, so the registry can't reference a non-boolean setting.

### 3.3 Settings UI — new `"plugins"` tab (in `App.tsx`'s settings modal)
- Extend the `SettingsTab` union with `"plugins"` and add a nav item.
- The tab renders a **"Core Plugins"** heading, then maps `CORE_PLUGINS`
  to toggle rows: name, description, and an on/off switch reusing the
  existing switch pattern (the `editor.raw_source_default` toggle).
- No component unit test (Contract E — operator-smoke; the repo has no
  Solid render harness).

### 3.4 State + persistence (`App.tsx`)
- A `Record<string, boolean>` signal of plugin enablement.
- On vault open, hydrate it from the per-vault settings (one
  `getSetting` per registry entry), mirroring how `theme_mode` loads.
- A toggle handler updates the signal and calls `setSetting(...)`,
  matching the existing setting-toggle handlers.

### 3.5 Editor gating (`App.tsx` → `Editor`)
- The `dataviewRunner` prop passed to `<Editor>` becomes
  `corePluginEnabled(state, dataview) ? dataviewRunner() : null`.
- Off ⇒ the field emits nothing ⇒ raw ```query text. The Editor already
  reconfigures the runner facet reactively when the prop changes, so the
  toggle is live both ways.
- The existing `dataviewRunner()?.invalidate()` call sites are
  unaffected (they no-op against the still-live runner object; only the
  *prop* is gated).

## 4. Data flow

```
Settings modal toggle
  → update enablement signal           (live)
  → setSetting("plugins.dataview_enabled", value)   (persist, per-vault)
  → Editor dataviewRunner prop flips (runner | null)
  → dataviewBlockField rebuilds → widgets or raw text
```

## 5. Testing

- `corePlugins.ts`: vitest for `corePluginEnabled` — stored true/false
  wins; absent falls back to `defaultEnabled`.
- Settings tab + editor gating: operator-smoke (Contract E), like the
  rest of the settings modal.
- Existing dataview tests stay green (gating is additive).

## 6. Future (planned successor): portable config sync

Not built here. Recorded so the toggle is forward-compatible and the
follow-up has a starting point. This needs its own spec **and** an
architecture amendment (it carves out config as portable, non-derived
state, which the current "everything in `.cubical/` is rebuildable from
markdown" rule does not allow).

**Goal:** vault config (all settings, not just plugin enablement) travels
with the vault, so a shared/exported vault carries what the user had
enabled.

**Model (converged):**
- **The file is the durable source of truth; the DB (`config` table) is a
  fast cache hydrated from it.** The app reads from the DB at runtime.
- **DB → file:** write-through on every UI settings change.
- **File → DB:** only on **vault open** and on an explicit **"Refresh
  settings"** action. **No file-watching** — the DB never reacts to the
  file on its own, so there is no watcher, no own-write echo suppression,
  and no live-conflict handling. Reconciliation is last-action-wins.
- **Open-time precedence:** if both file and DB exist and differ (the
  file was edited while the app was closed, or a vault was imported), the
  **file wins** at open. A stale DB never clobbers the file because DB →
  file happens only on a UI change.
- **Lazy creation:** opening a folder never writes anything. Missing file
  + empty DB ⇒ assume defaults, create nothing. Missing file + DB has
  data ⇒ recreate the file from the DB on open. Only a real settings
  change first creates the file (and rows).
- **Placement:** the file must live where vault-sharing naturally carries
  it — a small file at the vault root or its own tiny folder, **separate
  from the disposable `.cubical/` index cache** (sharing a vault is not
  expected to include the rebuildable index). This revisits the
  `.cubical/config.toml` location currently penciled in `vault.md`.
- **Conflicts:** last-action-wins; no 3-way merge (settings are
  low-stakes, unlike markdown).
- **Format:** decide JSON vs TOML/YAML in that spec (libSQL stores values
  as JSON today; `vault.md` pencils in TOML).

The Dataview toggle becomes this subsystem's first consumer when it lands.

## 7. Out of scope

Community/WASM plugins, plugin permissions UI, enable-all/disable-all,
the config-sync subsystem itself (§6), and any Rust change for this build.
