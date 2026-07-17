# Plan — B6: Properties cluster → @ds (Phase B, final slice)

**Branch:** `feat/design-system-migration`
**Parent plan:** [`2026-07-14-ds-component-library-migration.md`](2026-07-14-ds-component-library-migration.md)
**Goal:** the Properties inline-editing cluster (`ui/src/Properties.tsx` +
`ui/src/properties/*`) borrows its primitives from the design system, closing
out Phase B.

## Context

The Properties cluster is the frontmatter table shown above a note. It has its
own mini design system in `ui/src/properties/styles.ts`:

- `inputStyle(focused)` — text-like input; accent border while focused → **@ds TextInput**
- `chipStyle(isTag)` — rounded chip pill → **@ds Tag** (tag chips only; see Task 4)
- `miniButtonStyle()` — small chrome glyph button (`×`, `+ add`, `✎`) → **@ds IconButton** (small)

Surface: 13 buttons + 11 inputs + 2 selects across 10 files.

## Global Constraints (binding — these govern every task)

1. **The draft/focus-guard logic is load-bearing. Do not change it.** Cells hold
   a local `draft` signal and ignore incoming `value` prop changes while
   focused, so an `onAstChange`-driven row refresh cannot clobber an in-progress
   edit. `createEffect(on(() => props.value, …))` must keep tracking **only**
   `props.value` — adding `focused()` to the tracked deps reintroduces a fixed
   bug (blurring after an edit reverts the draft during the 150ms AST-tick
   window). Preserve commit-on-blur and commit-on-Enter semantics exactly.
2. **Extend the DS, never work around it in the app.** If a DS component lacks a
   prop, add it in `design-system/` (additive, optional, defaults preserve
   current DS behavior). Never re-add a bespoke app control to dodge a gap.
3. **Tokens only.** No raw hex, px, rem, or literal colors in any new code. Every
   value resolves to a `var(--…)` token. (Existing `rem` values inside
   already-migrated DS component CSS are not your concern.)
4. **Import convention:** `import X from "@ds/components/<area>/<X>/<X>";`
   (default exports, one folder per component).
5. **Delete dead CSS/helpers as you migrate.** When the last consumer of a
   `styles.ts` helper is gone, delete the helper. If consumers remain, leave it
   and say which remain.
6. **Gates must stay green:** `cd ui && npx tsc --noEmit`, `npx vitest run`
   (728 passing), `npm run build`. Run all three; report actual output.
7. **Verification reality — read this.** The vite dev preview has **no Tauri
   backend**: `invoke` calls never resolve, so the app sits in a `booting` state
   and the Properties table (vault-gated) **cannot be rendered live in a
   browser**. The parent plan's "verify by rendering the app" contract is not
   achievable for this cluster. Do **not** burn turns trying to open a vault,
   and do **not** claim a live render you did not perform. Verify via: tsc +
   vitest + build, plus — where a visual claim matters — rendering the exact
   class combos the component emits against the app's loaded CSS at
   `http://localhost:5173` and reading computed styles. Full live verification
   happens in Phase D under `cargo tauri dev`.
8. **Commit per task** with a message recording DS extensions made and dead code
   removed. Do not commit unrelated changes.
9. **Behavior fidelity over redesign.** This is a migration. Where a DS component
   produces a *small* visual delta (e.g. DS TextInput's `:focus-visible` outline
   ring where the app used `outline: none`), that is acceptable — report it. A
   *large* delta (density/height change in a dense table) is not — that is what
   the `sm` sizes in Task 1 exist to prevent.

---

## Task 1 — DS foundation: TextInput events + `sm`; IconButton `size`

**Files:** `design-system/src/components/forms/TextInput/TextInput.{tsx,css}`,
`design-system/src/components/forms/IconButton/IconButton.{tsx,css}`.
**No app changes in this task.** This unblocks Tasks 2–4.

### 1a. TextInput — event + input-mode passthrough

The inline-edit cells need handlers `TextInput` does not currently expose. Add
these optional props, all passed through to the underlying `<input>`:

- `onFocus?: () => void`
- `onBlur?: () => void`
- `onKeyDown?: (e: KeyboardEvent) => void`
- `inputMode?: string` → rendered as the `inputmode` attribute

Keep the existing `onInput(value: string)` value-shape (do not change it to an
event). Existing props/behavior must not change.

### 1b. TextInput — `size` variant

The cluster's inputs are dense; DS TextInput is a fixed `height: 32px` with
`padding: 0 var(--space-3)`, which would visibly fatten the Properties table.

Add `size?: 'sm' | 'md'` (default `'md'` — current look unchanged). `sm` must
match the outgoing `inputStyle` box: `height: auto`, `padding: var(--space-1)
var(--space-2)`. Follow the `classList` + CSS pattern DS Button already uses for
its `sm` size (`.text-input.sm { … }`).

### 1c. IconButton — `size` variant

`miniButtonStyle()` is a small glyph button; DS IconButton is a fixed
`1.9rem` square, too big for an inline cell affordance.

Add `size?: 'sm' | 'md'` (default `'md'` — current look unchanged). `sm` should
be a compact glyph button sized for inline use: no fixed square, `padding: 0
var(--space-1)`, `font-size: var(--text-xs)`, `line-height: 1`.

### DoD
- tsc clean (`cd ui && npx tsc --noEmit` — the app typechecks the DS via `@ds`).
- Defaults unchanged: an existing `<TextInput>`/`<IconButton>` with no new prop
  renders exactly as before. State how you confirmed this.
- No app files touched.

---

## Task 2 — Text-like cells → @ds TextInput

**Files:** `ui/src/properties/StringCell.tsx`, `NumberCell.tsx`,
`CurrencyCell.tsx`, `DateCell.tsx`.

Replace each bespoke `<input … style={inputStyle(focused())}>` with
`@ds TextInput` using `size="sm"` and the Task-1 event props.

- **Global Constraint 1 governs.** Keep every cell's draft/focus/commit logic
  byte-for-byte in behavior. You are swapping the *rendering* of the input, not
  its state machine.
- `StringCell` uses `ref` + `onMount` for `autoFocus` — TextInput already
  forwards `ref`; keep the autofocus working.
- `NumberCell` uses `inputmode="decimal"` — use the Task-1 `inputMode` prop.
- `DateCell` has 5 inputs; read it fully before editing. If any of its inputs is
  not a plain text input (e.g. a native date/time picker), leave that one bespoke
  and say why.
- The focused-accent-border is now DS TextInput's `:focus-visible` CSS. The
  `focused()` signal is still required for the draft guard — keep it even if it
  no longer feeds a style.

### DoD
- tsc + vitest (728) + build all green; paste actual output.
- Report: which inputs migrated, any left bespoke and why, and whether
  `inputStyle` still has consumers (EnumCell's `<select>` is expected to remain).

---

## Task 3 — BooleanCell → @ds Toggle; RawCell + EnumCell affordances

**Files:** `ui/src/properties/BooleanCell.tsx`, `RawCell.tsx`, `EnumCell.tsx`.

- **BooleanCell** is a hand-rolled switch (a `role="switch"` button wrapping a
  track + thumb built from inline styles). DS `Toggle` is exactly this component.
  Replace it. BooleanCell also renders a `true`/`false` text label beside the
  switch — DS Toggle's `label` prop is its *accessible name* only and renders no
  text, so keep the visible label as a sibling element. Preserve
  commit-on-click (no draft state) and the accessible switch semantics.
- **RawCell**'s "Open as raw" is a text link-button (accent, underlined) — map to
  `@ds Button variant="ghost" size="sm"` **only if** the result stays visually a
  text link. If a ghost Button reads as a chrome button rather than a link,
  leave it bespoke and say so. Judgement call — justify whichever you pick.
- **EnumCell**'s `✎` "Edit allowed values" glyph uses `miniButtonStyle()` → `@ds
  IconButton size="sm"`. EnumCell's *text input* (the comma-separated editor) →
  `@ds TextInput size="sm"` with the Task-1 event props.
- **EnumCell's `<select>` stays native.** There is no DS Select component;
  building one is out of scope. It keeps using `inputStyle`.

### DoD
- tsc + vitest (728) + build all green; paste actual output.
- Report each judgement call (RawCell especially) with its reasoning.

---

## Task 4 — ChipList + Properties.tsx

**Files:** `ui/src/properties/ChipList.tsx`, `ui/src/properties/StringListCell.tsx`
(if it renders chips), `ui/src/Properties.tsx`.

- **ChipList** (4 buttons, 1 input): read it fully first.
  - Its chips use `chipStyle(isTag)`. DS `Tag` renders `#{label}` with a
    **hardcoded `#` prefix** and has **no remove affordance**; `chipStyle` serves
    both tag chips (mono, accent, `#`-prefixed) and plain string chips.
    Decide per-chip-kind: use DS `Tag` where it genuinely fits, and if it does
    not fit, either extend DS Tag additively (Global Constraint 2 — e.g. an
    optional prefix/removable) or leave that chip bespoke. **State your reasoning
    either way.** Do not force a `#` onto a non-tag chip.
  - Its `×` remove and `+ add` glyphs use `miniButtonStyle()` → `@ds IconButton
    size="sm"`.
  - Its text input → `@ds TextInput size="sm"` (Global Constraint 1 applies if it
    holds a draft).
- **Properties.tsx** (6 buttons, 1 input): read it fully first. Map its buttons to
  `@ds Button`/`IconButton` per their role (chrome glyph → IconButton; labelled
  action → Button). Its input → TextInput if it is a plain text input.
- After this task, `styles.ts`'s `miniButtonStyle` and `chipStyle` should have no
  consumers left — **delete any helper whose last consumer you removed.** If a
  helper still has consumers, leave it and name them.

### DoD
- tsc + vitest (728) + build all green; paste actual output.
- Report: DS extensions made, helpers deleted from `styles.ts`, what remains
  bespoke and why.

---

## Out of scope (do not do these)

- Building a DS `Select` component (EnumCell's + App.tsx settings' `<select>`s
  stay native — tracked separately).
- Dialog shells → DS Modal, context menu → DS Menu (Phase C, behavioral).
- The `set-info-btn` ⓘ and tree-header glyphs in App.tsx (separate slice).
- Gutting the rest of `layout.css` (Phase D).
