# Small-wins UI batch — design

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Scope:** Five independent, mostly-small UI features from the requested backlog (`project_requested_ui_backlog`): #5 muted file-type labels, #7 three new bindable commands, #4 editor back/forward navigation, #3 minimal vault-switcher popup, #8 clearer Settings copy.

## Why one batch

The user explicitly requested "many small wins" in one pass, overriding the usual one-feature-per-session cadence. Four of the five are edits to surfaces that already exist; only follow-wikilink and the nav-history stack add genuinely new logic. Each feature is an isolated unit with its own commit at build time, so the batch stays reviewable despite its breadth.

Build order: **#5 → #7 → #4 → #3 → #8**, each its own commit. #8 goes last so it can document the surfaces #3/#4/#7 add.

---

## #5 — Muted file-type labels (display only)

**Problem:** Sidebar tree rows render the basename *with* extension (`roadmap.md`), so the `.md` noise competes with the note name.

**Design:**
- [`sidebar/fileTree.ts`](../../../ui/src/sidebar/fileTree.ts) is pure and unit-tested. Add an `ext` field to `FileLeaf` (the extension string *without* the dot, or empty string when the basename has none) computed alongside the existing `name`/`typeId`. `name` continues to carry the full basename; a new `stem` field carries the basename minus the trailing `.<ext>`. Extension parsing (last dot, ignore dotfiles like `.gitignore` where the dot is leading) lives here so it is testable without the app harness.
- [`App.tsx`](../../../ui/src/App.tsx) tree-row rendering shows `stem` as the primary label and, when `ext` is non-empty, a trailing `<span class="filerow__ext">` rendering `.{ext}` in a muted color.
- New CSS in [`styles/layout.css`](../../../ui/src/styles/layout.css) for `.filerow__ext` reusing an existing muted-text token (e.g. `--text-muted`); no new color primitives.

**Boundaries:** No behavior change — sort, selection, open, rename all still key off `path`. Folders unaffected.

**Tests:** `fileTree.test.ts` gains cases for `ext`/`stem` derivation: normal `a.md`, no-extension `README`, dotfile `.gitignore`, multi-dot `a.b.md`, uppercase `A.MD`.

---

## #7 — Three new bindable commands

Each is one `COMMAND_DEFAULTS` row in [`core/commands.ts`](../../../ui/src/core/commands.ts) plus a `run` closure supplied by the appropriate adapter. All three appear in the existing [`ShortcutsPanel`](../../../ui/src/settings/ShortcutsPanel.tsx) automatically, since it derives from `COMMAND_DEFAULTS`.

| id | title | scope | default key |
|---|---|---|---|
| `editor.followWikilink` | Follow link under cursor | editor | `Alt-Enter` |
| `view.toggleSidebar` | Toggle left sidebar | global | `Mod-Shift-l` |
| `file.new` | New note | global | `Mod-n` |

- **`editor.followWikilink`** — *new logic.* From the CodeMirror cursor, find an enclosing `[[…]]` token (walk the syntax tree / scan the line for the wikilink span containing the head), extract the target, resolve it through [`editor/wikilinkResolver.ts`](../../../ui/src/editor/wikilinkResolver.ts), and open the resolved note via the same path `handleSelectFile` uses. No-op (returns `false`, falls through) when the cursor is not inside a wikilink or the target does not resolve.
- **`view.toggleSidebar`** — wires to the existing `toggleLeftSidebar` (App.tsx:371).
- **`file.new`** — wires to the existing `handleNewFile` (App.tsx:1118).

**Defaults source:** matched to Obsidian's defaults. Cubical stores one binding in `Mod-` notation (`Mod` = ⌘ on macOS / Ctrl on Windows), so `Mod-Shift-l` = Obsidian's ⌘/Ctrl+Shift+L, `Mod-n` = ⌘/Ctrl+N, and `Alt-Enter` = Obsidian's Alt+Enter.

**Conflict check:** none of the three collide with the existing `Mod-k` / `Mod-e` / `Mod-Shift-b`, nor with #4's nav keys (verified against `findDuplicateBindings` semantics in `commands.ts`).

**Tests:** `commands.test.ts` — the three new rows resolve through `resolveBindings` and surface no `findDuplicateBindings` collision against the full default table. Follow-wikilink token-at-cursor detection gets pure unit tests (cursor inside/before/after/outside a `[[…]]`).

---

## #4 — Editor back/forward navigation

**Problem:** After following a link there is no way back without re-finding the previous note.

**Design:**
- New pure module `navHistory.ts` (in `ui/src/`, dependency-free, unit-tested): holds an ordered stack of visited paths + a current index, exposing `push(path)`, `back()`, `forward()`, `canBack()`, `canForward()`, `current()`. `push` truncates any forward entries (standard browser-history semantics) and de-dupes consecutive identical paths.
- [`App.tsx`](../../../ui/src/App.tsx) owns one `navHistory` instance. Every user-initiated open through `handleSelectFile` calls `push`. `back()`/`forward()` navigate to the returned path **without** re-pushing (a `navigating` guard flag distinguishes history-driven selection from user-driven).
- Surfaced two ways:
  - **Topbar** left flank: ‹ and › buttons, each `disabled` when `canBack()`/`canForward()` is false.
  - **Commands** `nav.back` / `nav.forward` (global scope) in `COMMAND_DEFAULTS`, defaults `Mod-Alt-ArrowLeft` / `Mod-Alt-ArrowRight` (= Obsidian's ⌘/Ctrl+Alt+←/→). They therefore also appear in the Shortcuts panel, satisfying the "back-button + shortcut" ask in one unit.

**Boundaries:** `navHistory.ts` knows nothing about files, IPC, or Solid — it is a list-with-a-cursor. App.tsx is the only adapter. History is session-scoped (not persisted).

**Tests:** `navHistory.test.ts` — push/back/forward ordering, forward-truncation on branch, consecutive-dupe collapse, `canBack`/`canForward` at boundaries, `current` after each op.

---

## #3 — Vault-switcher popup (minimal, no persistence)

**Decision:** The user chose the memory-less variant. A recent-vaults list needs a global (app-data) config store that does not exist today; that store is deliberately out of scope for this batch and gets its own session (an architecture decision about where non-vault state lives).

**Design:**
- New `VaultSwitcher.tsx` popover component. Trigger: clicking the vault name already rendered in the topbar (App.tsx:1999). Renders:
  - the current vault path (from `vaultPath()`), and
  - an **"Open folder…"** button that invokes the existing `openDialog({ directory: true })` → `openVault` flow (App.tsx:1394) — i.e. the switcher wraps, and does not replace, the current mechanism.
- **Forward-compatible seam:** the component takes a `recentVaults` prop typed as a list of `{ path: string }`, defaulted to `[]` and rendered as an (empty for now) section above the button. A future global-store session populates the prop without changing the component's shape or the trigger.

**Boundaries:** Presentational + one callback (`onOpenFolder`). No new persistence, no new IPC. Dismisses on outside-click / Escape like the existing info-popover.

**Known tradeoff (accepted):** with no remembered list, the popup offers little functional gain over today's button; it exists to move vault-switching into an in-app surface and to establish the seam the list drops into later.

**Tests:** component is operator-smoke per conventions (components are smoke-only); the pure trigger/dismiss behavior needs no new unit test beyond what the popover pattern already has.

---

## #8 — Clearer Settings copy (done last, copy only)

**Design:** Extend [`settings/settingsInfo.ts`](../../../ui/src/settings/settingsInfo.ts) with plain-language help text for settings/features currently lacking it, surfaced through the existing info-popover mechanism (`openInfo` / `flipInfo`, App.tsx:400). No new UI mechanism — only fuller content for the popovers that already exist, including entries describing the surfaces #3/#4/#7 just added.

**Deferred to the plan:** the exact list of setting keys needing new/expanded copy (enumerated during planning against the current `settingsInfo.ts` contents and the settings surface).

**Tests:** `settingsInfo.test.ts` — every referenced info id has non-empty copy; no dangling ids.

---

## Cross-cutting notes

- **No architecture impact** beyond the explicit non-goal for #3 (global store deferred). No new IPC commands. No changes to the `.md` source of truth or `.cubical/` layout.
- **One commit per feature**, in the build order above.
- **Verification:** `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) green, plus operator smoke of each UI surface (tree labels, each shortcut firing, back/forward buttons + keys, switcher popup open/dismiss/open-folder, settings popovers).
