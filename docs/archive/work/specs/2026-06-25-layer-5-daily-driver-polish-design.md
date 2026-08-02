> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Layer 5 — Daily-Driver Polish — Design

**Date:** 2026-06-25
**Status:** In progress. Umbrella design covering all four L5 surfaces, built
incrementally; canonical per-layer status is owned by
[`build-order.md`](../../build-order.md) → Layer status & tags.
**Deviation:** the keymap registry shipped *beyond* this spec — §6 lists
user-remappable bindings as out of scope, but configurable shortcuts shipped
2026-07-06.
**Scope:** This is the **public v1.0 cut** ([`build-order.md`](../../build-order.md)).
Post-L5 is L6 Plugins.

---

## 1. Why

Layer 5 is the line where Cubical becomes a tool someone uses every day and the
v1.0 release is cut. The substrate (vault, AST, index, editing, knowledge graph,
search) is in place; L5 adds the polish that makes it pleasant: a real theme
picker, an escape hatch to get content out, consolidated keyboard shortcuts, and
the removal of known performance anti-patterns. Per
[`build-order.md`](../../build-order.md), L5 = *theme picker, export sanitization,
perf pass, keyboard shortcuts*.

The four surfaces are **independent** (no shared state or interface), so this doc
is an umbrella: one design, built and shipped incrementally, each surface
verifiable on its own.

## 2. Scope summary

| Surface | In v1.0 | Out of v1.0 |
|---|---|---|
| **Theme picker** | Picker UI for built-in palette + light/dark/system mode; user themes scanned from `<vault>/.cubical/themes/*.css` | Font family/size overrides; High-Contrast built-in; plugin themes (L6) |
| **Export** | `sanitize()` seam (identity pre-L7) + one **Copy-as-Markdown** action (whole note) | HTML/PDF export; selection-scoped copy |
| **Keyboard shortcuts** | Centralized command/keymap registry binding existing core actions | User-remappable bindings; command palette; cheat-sheet overlay |
| **Perf pass** | The four anti-patterns from [`anti-patterns-2026-06-01.md`](../../anti-patterns-2026-06-01.md) | Indexing-scale strategy; Pretext virtualization |

## 3. Approach

**Substrate-first (Approach A).** Build the one piece of genuinely new substrate —
a **command/keymap registry** in the `core/` layer — and consolidate today's
scattered key handlers into it. The features then hang off stable seams:

- shortcuts *are* the registry;
- Copy-as-Markdown registers as a command + binding;
- the theme picker enhances the **existing** Settings ▸ Appearance tab
  ([`ui/src/App.tsx`](../../../ui/src/App.tsx) settings modal);
- the `sanitize()` seam is a reserved checkpoint in the existing materialized-read
  path (Rust).

The **perf pass is an orthogonal backend track** and can land at any point.

This dovetails with the in-flight
[UI composition refactor](../plans/2026-06-23-ui-composition-refactor.md):
the registry is new `core/` substrate, and consolidating handlers pulls more logic
out of the `App.tsx` god-component rather than adding to it.

## 4. Theme picker

Enhances the existing **Settings ▸ Appearance** tab. The L2 mechanism
([`ui/src/styles/theme.ts`](../../../ui/src/styles/theme.ts):
`resolveTheme`/`applyTheme`/`watchSystemTheme`, live `data-theme` switch,
CM6 theme generated from the token surface) is reused; L5 adds the user-facing
layer.

### 4.1 Two orthogonal axes

Mode and theme are **independent** — neither replaces the other:

- **Mode** — `appearance.theme_mode` ∈ `light | dark | system`. **Default:
  `system`.** Unchanged field from L2. Decides light-vs-dark.
- **Theme (skin)** — `appearance.theme` ∈ `default | <user-theme-name>`.
  **Default: `default`.** *New* field. Decides the palette.

They combine: the **theme** chooses the palette, the **mode** chooses light/dark
*within* that palette. Every theme — the built-in `default` and each user theme —
is expected to define **both** a light and a dark token set, keyed off
`data-theme`. A theme that defines only one mode falls back to base tokens for the
other.

**Migration:** existing `appearance.theme_mode` values pass straight through;
`appearance.theme` is absent → `default`. Both live in `config.toml` (durable
per-vault settings, [`vault.md`](../../architecture/vault.md) §4.1). Mode
resolution stays in the frontend — only the webview sees `prefers-color-scheme`.

### 4.2 User themes

- A Rust IPC scans `<vault>/.cubical/themes/*.css` and returns the available theme
  names (identity = filename). Called on vault open; the picker populates from it.
- Selecting a user theme injects/swaps a **managed `<style>` element** loaded
  *after* `tokens.css`, overriding token values. Selecting `default` removes it.
- `applyTheme` continues to own the `data-theme="light|dark"` attribute (mode);
  the skin injection is a separate apply step.

### 4.3 CM6 sync (load-bearing detail)

[`theme.ts`](../../../ui/src/styles/theme.ts) generates the **CodeMirror editor
theme programmatically from the computed token values**. Therefore, after *either*
the mode or the skin changes, the app must **re-read computed tokens and
regenerate the CM6 theme**, so the editor never desyncs from the rest of the UI.
This is the one integration point that must not be skipped.

## 5. Export — Copy-as-Markdown + sanitize seam

- **Action `export.copyMarkdown`** — "Copy as Markdown": copies the **whole active
  note's materialized content** (pending rewrites applied, per
  [`document-model.md`](../../architecture/document-model.md) §"Reads
  materialize") to the clipboard, via the **existing materialized-read path**.
  Registered as a command (§6) with a binding.
- **Sanitize seam** — a documented, reserved checkpoint in that path. Pre-L7 it is
  the **identity function** (no `cubical_id` exists to strip,
  [`vault.md`](../../architecture/vault.md) §4.2); at L7 it strips the minted
  `cubical_id`. **No standalone sanitize subsystem is built now** — building a
  Rust module for a no-op would be over-engineering.

This delivers the no-lock-in escape hatch (foundation commitment 3) while keeping
the work proportional to its present value.

## 6. Keyboard shortcuts — command/keymap registry

Today shortcuts are scattered: a global `keydown` for Cmd/Ctrl+K
([`App.tsx`](../../../ui/src/App.tsx)), a CM6 `keymap` in
([`Editor.tsx`](../../../ui/src/Editor.tsx): `Mod-e`, `Mod-Shift-b`), and ad-hoc
`onKeyDown` handlers across components. L5 introduces a **single registry** in the
`core/` layer.

- A **command** = `{ id, title, run(), when?() }`. A **binding** maps a key to a
  command id within a **scope** (`global` | `editor`).
- Bindings are a **static const table** in v1 (no user remapping), which sidesteps
  reactive-rebinding complexity entirely.
- The registry **consolidates** the existing app-level handlers; the CM6 keymap is
  generated from the registry's `editor`-scope bindings so the editor and app
  share one source of truth.
- A **dev-time test asserts no duplicate `key` within a scope** — cheap insurance
  against a silent keymap clash.

Out of v1 (additive once the registry exists): user-remappable bindings, a
command palette, a `?` cheat-sheet overlay.

## 7. Perf pass — four anti-patterns

Backend track, orthogonal to the UI work. Fixes the four still-open items from
[`anti-patterns-2026-06-01.md`](../../anti-patterns-2026-06-01.md)
(re-validated still-open 2026-06-17):

1. **N+1 in vault scan** — batch the per-file work.
2. **Full-tree decoration walk** — scope the editor decoration pass to the
   viewport/changed range instead of the whole tree.
3. **Row-at-a-time INSERTs** — batch index writes into a single transaction /
   multi-row insert.
4. **Sequential async** — parallelize independent awaited work.

**Verification (honest):** each fix is verified by the **structural change + the
existing test suite staying green**, *not* by a measured speedup — no perf budget
/ benchmark harness is in scope, so the cut bar reads "anti-pattern removed," not
"X% faster."

## 8. Testing

- **Command registry** — registry + binding table unit-tested in isolation
  (`core/`), including the no-duplicate-key assertion.
- **Theme** — data-model resolution (mode × skin) + migration unit-tested pure,
  no DOM (like the existing [`theme.test.ts`](../../../ui/src/styles/theme.test.ts)).
- **User-theme scan IPC** + **Copy-as-Markdown** materialized read — tested on the
  Rust side.
- **Perf fixes** — ride the existing suites (structural correctness).
- All work passes `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs).

## 9. v1.0 cut bar — L5 is done when

1. Theme picker: mode × skin both switchable live; user themes scanned & applied;
   CM6 stays in sync.
2. Centralized keymap registry owns the app-level shortcuts; scattered handlers
   consolidated.
3. Copy-as-Markdown works, with the sanitize seam reserved.
4. All four anti-patterns removed.
5. All gates green (`scripts/check.sh`).
6. Docs updated: [`build-order.md`](../../build-order.md) L5 row + tag;
   [`architecture/ui.md`](../../architecture/ui.md) and
   [`architecture/vault.md`](../../architecture/vault.md) where behavior changed;
   a `layer-5-spec.md` "what was built" record.

This is the **public v1.0 cut**. Post-L5 is L6 Plugins
([`planned.md`](../../architecture/planned.md) §8).
