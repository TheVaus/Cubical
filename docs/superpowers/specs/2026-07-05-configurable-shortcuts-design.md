# Configurable shortcuts

**Date:** 2026-07-05
**Status:** Design — approved, pre-implementation
**Surface:** `ui/src/core/commands.ts`; Settings → Shortcuts tab in `ui/src/App.tsx`; `ui/src/Editor.tsx` keymap wiring

## Problem

`ui/src/core/commands.ts` already has a clean command registry — a static
`DEFAULT_BINDINGS` table, `resolveGlobal` (App-level keydown adapter), and
`toCmBindings` (CodeMirror keymap adapter) — but its own doc comment says
"Bindings are a static const table in v1 — no user remapping." Settings has a
read-only "Shortcuts" tab that just lists the three current bindings as
`<kbd>` tags with no way to change them.

## Goal

Users can rebind any of the app's keyboard shortcuts from Settings → Shortcuts,
with changes taking effect immediately and persisting per-vault. This session
covers the *infrastructure* plus the existing three commands
(`omnibar.toggle`, `editor.toggleRawSource`, `editor.copyBlockRef`); future
sessions adding new commands (back-navigation, wikilink-at-cursor, etc.) just
add entries to the same table — no changes to the mechanism.

## Data model

`commands.ts` gains a metadata table decoupled from the runtime `Command`
closures, so the settings UI can list/display commands without needing
vault-dependent `run` closures:

```ts
export interface BindingDefault {
  id: string;         // "omnibar.toggle"
  title: string;       // "Toggle Omni-Bar"
  scope: CommandScope;
  defaultKey: string;  // "Mod-k"
}
export const COMMAND_DEFAULTS: readonly BindingDefault[];
```

`DEFAULT_BINDINGS` (the `{key, command, scope}[]` shape `resolveGlobal`/
`toCmBindings` already consume) is derived from `COMMAND_DEFAULTS` rather than
hand-duplicated.

### Storage

One new per-vault setting, `shortcuts.overrides`: a JSON object mapping
command id → key spec, holding **only** commands the user has changed from
default (a diff, not a full snapshot):

```json
{ "omnibar.toggle": "Mod-Shift-p" }
```

Persisted via the existing generic `get_setting`/`set_setting` IPC (already
used for every other per-vault setting) — no backend changes. The diff
approach means a future session adding a new default command is picked up
automatically by existing users; a full-snapshot approach would silently
freeze them on whatever command set existed when they last touched Settings.

### Resolution

A pure function in `commands.ts`:

```ts
function resolveBindings(overrides: Record<string, string>): KeyBinding[]
```

Merges `COMMAND_DEFAULTS` with `overrides` (override wins per command id,
ignoring overrides that reference an unknown command id — e.g. left over from
a removed command) into the effective `KeyBinding[]`.

## Runtime wiring

- App.tsx loads `shortcuts.overrides` into a signal on vault open (same
  pattern as `themeMode`, `minimapEnabled`, etc.), and derives
  `effectiveBindings = createMemo(() => resolveBindings(shortcutOverrides()))`.
- `onGlobalKey` (App.tsx) calls `resolveGlobal(effectiveBindings(), ...)`
  instead of `DEFAULT_BINDINGS`.
- Editor.tsx's CodeMirror keymap is built from `toCmBindings(effectiveBindings(), ...)`
  through a `Compartment`, so editing a shortcut reconfigures the live
  editor's keymap immediately — no reopen required.
- Saving an override updates the `shortcuts.overrides` signal and calls
  `persistSetting(vaultId(), "shortcuts.overrides", overrides)`.

## Settings UI

The Shortcuts tab's read-only `kb-row` list becomes one editable row per
`COMMAND_DEFAULTS` entry:

- **Display**: command title, current chord rendered via a new
  `formatChordForDisplay(spec)` helper (replaces the hand-written `⌘/Ctrl`
  JSX with something generated from the parsed `KeyChord`, so it doesn't need
  hand-duplicating as commands are added).
- **Change**: click → row enters a per-row "listening" signal state showing
  "Press keys…"; the next `keydown` is captured, normalized via
  `eventToChord`, and converted to a spec string. Esc cancels back to the
  current chord without committing.
- **Conflict check**: before committing a captured chord, check it against
  every *other* command's effective binding **within the same scope**
  (`global` and `editor` are independent key spaces — they never compete for
  the same event, so cross-scope matches aren't conflicts). If taken, show an
  inline error under the row ("Already used by *Toggle Raw Source*") and stay
  in listening state so the user can try again — a conflict does not dismiss
  capture mode.
- **Reset**: shown only when a row's effective key differs from its default;
  removes that command's key from `shortcuts.overrides` entirely (not
  "restores a stored default value") — consistent with the diff model, so a
  future change to that command's factory default is picked up.
- No clear/unbind control: every command always has exactly one active
  shortcut in v1.

## Out of scope

- Unbinding a command (no shortcut at all).
- Remapping a command's *scope* (global vs. editor) — only the key changes.
- Chord sequences (e.g. "press K then B") — single chords only, matching
  today's bindings.
- Any new commands (back-navigation, wikilink-at-cursor, etc.) — those are
  separate future sessions that will each just add a `COMMAND_DEFAULTS` entry.

## Testing

- `commands.ts` unit tests: `resolveBindings` merges overrides correctly,
  falls back to defaults for commands with no override, ignores overrides
  referencing unknown command ids.
- New conflict-detection helper (`findConflict(chord, scope, effectiveBindings, excludeCommandId)`)
  unit tests: same-scope collision detected; cross-scope (global vs. editor)
  not flagged; re-capturing the same key already assigned to the row being
  edited doesn't false-positive as a conflict.
- Settings UI component test: Change → keydown → row updates; Esc cancels;
  conflict shows inline error and stays in listening state; Reset removes the
  override and reverts display to the default chord.
- No Rust-side tests needed — this never touches the engine;
  `get_setting`/`set_setting` are already covered.
