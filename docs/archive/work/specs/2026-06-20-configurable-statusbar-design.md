> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Configurable status bar — design

**Date:** 2026-06-20
**Status:** approved (pending implementation plan)
**Scope:** one feature surface (+ a small omnibar command-kind extension the user opted into)

## Goal

Make the bottom status bar (`<footer class="statusbar">`, `ui/src/App.tsx:2292`)
user-configurable:

1. A **master on/off** — when off, the whole footer is unmounted (gone, not an
   empty strip).
2. When on, **per-item visibility** for each configurable segment.
3. A **quick toggle** runnable from the omnibar (new command-kind), so the bar
   can be flipped without opening Settings.

Defaults preserve today's behavior exactly: every key defaults to visible/on, so
an existing vault with no `statusbar.*` keys looks identical after upgrade.

## What is and isn't configurable

The footer renders three zones:

- **Left:** vault path · scanning progress · broken-refs warning · pending-rewrites indicator
- **Middle:** word count · block count (only when a file is open)
- **Right:** current file path

**Configurable per-item** (4 toggles): vault path, file path, word count, block count.

**Always-on** (gated only by the master): the three transient system alerts —
scanning progress, broken-refs warning, pending-rewrites indicator. These are
warnings, not chrome; the user explicitly chose not to make them hideable.

## Settings model — durable, per-vault

Five new keys under a new `statusbar.` namespace (one master + four item
toggles), all boolean, all default `true`. Durable (not `ui.*`), so they persist
to `.cubical/config.toml` and travel with the vault — consistent with
`appearance.theme_mode`.

| Key | Controls |
|---|---|
| `statusbar.enabled` | Master on/off; when `false`, footer unmounts |
| `statusbar.show_vault_path` | Left: vault path |
| `statusbar.show_file_path` | Right: current file path |
| `statusbar.show_word_count` | Middle: word count |
| `statusbar.show_block_count` | Middle: block count |

Added to the `Setting` union in `ui/src/api/ipc.ts:253`. **No Rust changes** — the
settings layer (`crates/cubical-core/src/vault/settings.rs`) is schemaless; it
flattens any dotted key to/from TOML. Durable keys (non-`ui.`) already route to
`config.toml` via `is_workspace_key`.

## New pure module — `ui/src/statusbar/segments.ts`

Mirrors `ui/src/settings/corePlugins.ts` so it's unit-testable in isolation.

```ts
import type { BooleanSettingKey } from "../settings/corePlugins";

export interface StatusbarSegment {
  id: string;                  // "vault_path" | "file_path" | "word_count" | "block_count"
  name: string;                // "Vault path"
  description: string;
  settingKey: BooleanSettingKey;
  defaultVisible: boolean;     // true
}

export const STATUSBAR_SEGMENTS: StatusbarSegment[]; // the 4 item rows

/** stored value, else the segment default. */
export function segmentVisible(
  state: Record<string, boolean>,
  seg: StatusbarSegment,
): boolean;
```

`segments.test.ts` (vitest): covers stored-vs-default resolution and that
`STATUSBAR_SEGMENTS` keys are unique and well-formed.

## Separator robustness (folded-in improvement #1)

Today the left and middle groups hardcode **leading** `·` separators (vault path
first, then each following item prefixed with `·`). Once items are hideable, a
hidden leading item leaves a dangling `·` (e.g. vault path off but a scan
active → ` · Scanning…`).

Fix structurally, not with nested `<Show>`: build the list of segments that
should render *right now*, then interleave `·` between adjacent visible members.
Apply to both the left group (vault path + the always-on alerts) and the middle
group (word/block count). A small pure helper is acceptable here but not
required to be its own file; if extracted, it gets a test.

## App.tsx wiring

- **State:** a `statusbarConfig` signal (`Record<string, boolean>`) plus a
  `statusbarEnabled()` accessor, seeded on vault-open from `getSetting` for each
  `statusbar.*` key — mirroring how `corePlugins` is seeded (`App.tsx:1264`).
- **Setter:** `setStatusbarSegment(key, value)` → `setSetting` + signal update,
  mirroring `setCorePlugin` (`App.tsx:758`).
- **Footer render (`App.tsx:2292`):** wrap the `<footer>` in
  `<Show when={statusbarEnabled()}>` (in addition to the existing
  `<Show when={vaultId()}>`); wrap each configurable segment in its own `<Show>`;
  apply the separator-interleave approach above.

**Empty-bar behavior (decided):** we do **not** auto-collapse when the master is
on but every item is off and no alert is active. The bar stays as-is —
predictable: master-on means the bar is present. Only the master toggle removes it.

## Settings UI — new "Status bar" tab

- Add `"statusbar"` to the `SettingsTab` union (`App.tsx:276`) and to the nav
  list (`App.tsx:1849`).
- Tab content (reusing existing `set-row` / `seg-control` markup from the Plugins
  tab, `App.tsx:2124`):
  - A master **On/Off** segmented control bound to `statusbar.enabled`.
  - A `<For each={STATUSBAR_SEGMENTS}>` of On/Off rows, **disabled and dimmed
    when the master is Off**.

## Omnibar command-kind (improvement #3, opted-in)

The omnibar (`ui/src/omnibar/`) is currently a note/tag quick-switcher with no
command concept. Introduce a minimal command-kind so it can run actions, seeded
with the status-bar toggle. This intentionally lays a small command-palette
foundation.

### `ui/src/omnibar/ranker.ts`

- Extend the union:
  ```ts
  export type OmniItem =
    | { kind: "note"; title: string; path: string }
    | { kind: "tag"; tag: string }
    | { kind: "command"; id: string; title: string };
  ```
- `matchText`: return `title` for commands.
- Tie-break sort (`ranker.ts:158`): extend the kind ordering to
  note → tag → command (commands last on ties). Update the test.

### `ui/src/omnibar/commands.ts` (new, pure)

A registry of command descriptors as data (`id`, `title`), unit-tested. Effects
live in App (descriptors can't hold app setters). Initial entry:
`{ id: "statusbar.toggle", title: "Toggle status bar" }`.

### `ui/src/omnibar/OmniBar.tsx`

- Props: add `onRunCommand: (id: string) => void`.
- `activate` (`OmniBar.tsx:69`): dispatch `kind === "command"` → `onRunCommand(id)`.
- Result row (`OmniBar.tsx:230`+): add a command badge (distinct glyph, e.g. `⚡`)
  and an appropriate subtitle/empty subtitle.

### `ui/src/App.tsx`

- `omniItems` memo (`App.tsx:339`): append command items from the registry.
- Wire `onRunCommand` on `<OmniBar>` (`App.tsx:1816`): dispatch by id;
  `statusbar.toggle` flips `statusbar.enabled` via `setStatusbarSegment`.

## Testing

- New vitest: `statusbar/segments.test.ts`.
- New vitest: `omnibar/commands.test.ts`.
- Update `omnibar/ranker.test.ts` for the command tie-break.
- Separator helper test if extracted.
- Full gate: `scripts/check.sh` (cargo fmt/clippy/test, tsc, vitest, build, docs).

## Out of scope (YAGNI)

- Segment reordering.
- A live status-bar preview inside the Settings tab.
- A broader command palette beyond the single toggle (the command-kind is built,
  but we seed only the one command).
- Making the system alerts hideable.
