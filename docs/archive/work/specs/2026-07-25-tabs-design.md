> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Tabs / multi-document editing (design)

**Date:** 2026-07-25
**Status:** designed, not built
**Closes:** issue #20 — "feature: Tabs / multi-document editing"
**Unblocks:** [`2026-07-25-cli-console-phase3-design.md`](2026-07-25-cli-console-phase3-design.md)
(the CLI command console is a tab kind and cannot be built until this lands)
**Durable rationale lands in:** [`../../implementation/frontend.md`](../../implementation/frontend.md)

---

## What this is

Multiple open documents in the center workspace, one visible at a time. Issue #20 calls
this "an architecture fork … it touches editor lifecycle, state ownership, and the
active-document model," and that is accurate: the work is not the tab strip, it is lifting
the active-document model out of `App.tsx`.

**Splits are out of scope.** Tabs only. Issue #20 bundles tabs and splits; this spec takes
the tabs half and leaves the pane tree, focus model, and per-pane tab strips for a later
project.

Today `App.tsx` (2717 lines, ~50 signals) personally owns the active document, and the
`topbar__tabs` markup renders exactly one placeholder `tab--active` div.

---

## 1. The invariant that makes everything else safe

> **Only the active tab can be dirty**, because activating a tab flushes autosave first.

`App.tsx` has **one** `dirty` flag, **one** `autosaveTimer`, and **one** `pendingWrite`
(≈L435–L544), and `handleSelectFile` already does `await flushAutosave()` before switching
(≈L758). Lifting that machinery naively to N tabs is the sharpest correctness hazard in
this project: tab B's timer firing against tab A's buffer can write A's text to B's path.

Keeping the autosave machinery **global and unchanged**, and flushing on activation,
removes the hazard by construction rather than by careful bookkeeping. It also preserves
today's semantics instead of inventing new ones, and — see §3 — it is what makes editor
eviction safe.

Rejected alternative: per-tab `dirty` / timer / `pendingWrite`. Strictly more moving parts,
three new ways to get a cross-tab write wrong, and no user-visible gain.

**Known exposure, unchanged from today:** if the flush write fails, activation proceeds
with unflushed content. Today's code has exactly this exposure on file switch. The error
surfaces the same way; this spec does not widen or narrow it.

---

## 2. The tab model

New `ui/src/tabs/tabModel.ts`, written in the style of `navHistory.ts` — immutable
operations over a plain value, no framework types, fully unit-testable:

```ts
export type TabView =
  | { kind: "file"; path: string }
  | { kind: "tag"; tagPath: string };

export interface Tab { id: string; view: TabView }
export interface TabSet { tabs: Tab[]; activeId: string | null }
```

Operations: `openTab`, `closeTab`, `activateTab`, `moveTab`, `nextTab`, `prevTab`.

**`id` is derived from the view** — `file:notes/Daily.md`, `tag:#foo` — so opening an
already-open document **activates its existing tab rather than duplicating it**. Opening
the same file twice is therefore not possible. This is a deliberate simplification: it
removes identity bookkeeping, and duplicate views of one file only earn their keep once
splits exist.

**Nav history is global, not per-tab** — one app-wide `NavState`, exactly as today.
Back/forward means "previously visited document" and may switch which tab is active.

This reverses an earlier decision in this spec, and the reason is worth recording because it
is structural rather than incidental. Per-tab history requires a tab to be a *container* that
shows different documents over time. Dedupe-on-open makes a tab **be** a document: navigating
to another note activates that note's own tab rather than changing the current tab's content.
So a tab's history can only ever hold the one path it was created with — `navPush` no-ops on
the path already current — and back/forward is dead in every tab, permanently.

The two decisions are individually reasonable and jointly incompatible. Keeping dedupe-on-open
(§2) means history must be global. The alternative — opaque tab ids, in-tab navigation, and
duplicates allowed — is the browser/Obsidian model and was rejected with the duplicates
question.

Caught during implementation, after the per-tab version had shipped in the tab model and been
wired into `App.tsx`; both the implementer and the reviewer traced it independently. `Tab` has
no `nav` field and `tabModel` has no `updateNav`.

The CLI console spec adds `{ kind: "console" }` to `TabView`. Nothing else in this spec
needs to know about it — that is the point of keying tabs by view kind.

**The strip replaces the placeholder.** `App.tsx`'s existing `topbar__tabs` block, which
today renders one `tab--active` div for the current file, becomes the real tab strip: a
`ui/src/tabs/TabStrip.tsx` rendering the `TabSet` with close buttons and drag reorder.

**Shortcuts go through the existing registry.** The app already has a configurable-shortcut
command registry (`view.toggleSidebar` is the pattern). Tabs register `view.nextTab`,
`view.prevTab`, and `view.closeTab` there, so they are rebindable like everything else
rather than hard-coded key handlers.

---

## 3. Editor lifecycle: keep-alive with an LRU cap

`Editor.tsx` (747 lines) is a controlled component — `value` in, `onContentChange` out,
plus an `EditorApi` ref — and holds CodeMirror state, including the undo stack, internally.
Swapping `value` on a single shared instance would reset undo, scroll, and cursor on every
tab switch, which reads as a bug the moment tabs exist.

So: **each tab keeps its `Editor` mounted, capped at N live instances (LRU), with the
active tab pinned.**

**N is configurable.** New setting `editor.live_tab_limit` (number, **default 8**), exposed
in the Settings modal's Editor tab alongside the other `editor.*` knobs. The default is a
guess, not a measurement, which is precisely why it is a knob. Values are clamped to a
minimum of 1 — the active tab is always live, so 0 is not a meaningful setting — and the
clamp lives with the LRU policy so a hand-edited `.cubical/config.toml` cannot break the
workspace.

It is a vault setting rather than machine-local state, matching
`pending_rewrites.flush_interval_secs`, the existing numeric tuning knob. The honest
trade-off: a vault synced between a 64 GB desktop and an 8 GB laptop gets one cap for both.
Machine-local would fit the semantics better, but the app's only machine-local store
(`recent_vaults.json`) is not a settings system — no schema, no Settings-modal plumbing —
and building that for a single number is not worth it. Revisit if a second machine-scoped
knob ever appears.

Because of §1's invariant, **an evicted tab is always clean**. Therefore re-activating an
evicted tab simply **re-reads the file from disk** — there is no content cache in the tab
model. That is not merely simpler; it is the CLAUDE.md non-negotiable applied literally:
plain `.md` files are the absolute source of truth, so disk is the correct place to
rehydrate from.

| | survives eviction |
|---|---|
| tab and its position | yes |
| CodeMirror undo stack, scroll, cursor | no |

At the default of 8, the loss only bites on the 9th-least-recently-used tab. Uncapped
keep-alive was rejected: unbounded CodeMirror instances is a poor trade in an app whose
selling point is being blazing-fast.

---

## 4. Lifecycle edges

- **Rename.** Tab ids embed the path, so renaming a file must remap any open tab. Today
  `handleRename` only fixes `selectedPath`. This is the edge most likely to be missed.
- **External delete.** The watcher already refreshes the file list; a tab whose file has
  vanished closes.
- **Vault switch.** Clear the tab set, then restore that vault's session (§5).
- **Closing the active tab.** Activate the neighbour to the right, falling back to the
  left; an empty tab set shows the existing empty state.

---

## 5. Session restore

New `crates/cubical-app/src/tab_sessions.rs`, mirroring `recent_vaults.rs` in structure:
pure functions over a `&Path`, JSON payload, atomic write via `.tmp` + rename, store path
resolved from the Tauri app-data dir (`recent_vaults.rs`'s `recent_vaults_store` is the
template; this one resolves `tab_sessions.json`).

Keyed by vault path; stores the ordered tab list and the active id.

**Machine-local, deliberately not `.cubical/config.toml`.** Which tabs you had open is not
something that should travel with a vault shared between machines or people. This follows
the recent-vaults precedent, which established machine-local state as app-shell-owned.

On restore, tabs whose file no longer exists are dropped, the way
`recent_vaults::list_with_existence` drops vanished vaults.

---

## 6. Scope discipline

The per-document slice moves out of `App.tsx` into `ui/src/tabs/`; the other ~2700 lines
are left alone. This is a targeted improvement in the code the work touches, **not** a
wholesale `App.tsx` refactor. Signals that move: `view`, `selectedPath`, `navState`, and
the tag-view state that hangs off them. Signals that stay global: files, folders, theme,
settings, sidebars, autosave (§1).

---

## 7. Testing

Pure modules get unit tests, following the project's existing pattern of pulling logic out
of components so it can be tested without a DOM (`navHistory.ts`, `fileTree.ts`,
`virtualList.ts` are precedent):

- `ui/src/tabs/tabModel.test.ts` — every operation, including dedupe-on-open and
  close-active neighbour selection.
- `ui/src/tabs/lru.test.ts` — eviction order, active-tab pinning, and the
  `editor.live_tab_limit` clamp (0 and negatives behave as 1).
- `crates/cubical-app` `tab_sessions` tests — the shape `recent_vaults.rs` already uses,
  including dropping vanished files on restore.
- A tab-strip render test.

**Two load-bearing tests**, both guarding §1 and §4 — the places where this design can
silently corrupt user data rather than merely misbehave:

1. **The dirty invariant.** Edit in tab A, switch to tab B, assert A's content landed on
   A's path and B's file is untouched.
2. **Rename remapping.** Rename a file with its tab open; assert the tab still points at
   the document and its nav history is intact.

Full gate is `scripts/check.sh`. Two standing gotchas: piping it to `tail` masks its exit
code, and `cubical-core`'s `dropping_handle_stops_event_delivery_within_100ms` is a known
flake under full-workspace load.

---

## 8. Out of scope

Splits and the pane tree; duplicate tabs of one file; tab groups; pinned tabs; drag-and-drop
between windows; preview/italic "temporary" tabs; persisting CodeMirror undo history across
restarts or eviction.
