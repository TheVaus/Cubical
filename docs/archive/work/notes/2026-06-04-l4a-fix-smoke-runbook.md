> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L4-A-fix smoke runbook

> Consolidated four-layer smoke (L1 + L2 + L3 + L4-A) against the
> L4-A smoke vault, executed before the `l4a-fix` tag lands.
> Each section pulls recipes from the corresponding layer spec.
>
> **Operator:** [your identifier]
> **Date:** [YYYY-MM-DD]
> **Build commit:** [`git rev-parse HEAD`]
> **Vault:** `~/Developer/sandbox/cubical-l4a-smoke/`
>
> Convention: each step has an expected outcome and a blank line
> for the actual observation. Mark `[x]` after passing.

---

## 1. Boot

- [ ] Run `cargo tauri dev`. Native window opens within 60s.
  Observation:

- [ ] File menu → Open Vault → `~/Developer/sandbox/cubical-l4a-smoke/`.
  File tree populates with A.md, B.md, C.md, plus L3 + L4-A test
  files (`Aliased Note.md`, `code/rust_examples.md`,
  `code/python_examples.md`, `data/frontmatter_rich.md`, and L3
  carryover files).
  Observation:

- [ ] Open dev console (Cmd-Option-I). No errors at boot.
  Observation:

## 2. L1 carry-over (layer-1-spec §5)

- [ ] Click a markdown file → editor shows raw markdown of that file.
  Observation:

- [ ] Type a character → `onAstChange` fires; footer / Properties
  panel reflects updated AST within ~200ms.
  Observation:

- [ ] In an external terminal:
  `echo "external edit" >> ~/Developer/sandbox/cubical-l4a-smoke/A.md`
  Within ~2s: `vault:file-changed` surfaces (conflict banner, OR
  editor reloads silently if buffer was clean).
  Observation:

## 3. L2 surface (layer-2-spec §9.7)

- [ ] **Autosave + conflict banner.** Edit a file, do nothing for
  ~500ms. Confirm autosave fires (no banner). Now externally edit
  the same file via terminal. Banner appears with Reload / Keep buttons.
  Observation:

- [ ] **Live Preview decorations.** Open a file containing each of:
  ATX heading, Setext heading, **strong**, *em*, `inline code`,
  ```fenced code blocks```, `> quote`, `- list`, `[text](url)`.
  Confirm each renders styled, marker tokens hidden off the cursor
  line, revealed on it.
  Observation:

- [ ] **Settings round-trip.** Toggle a setting (theme picker is
  fine), close and reopen the vault, confirm the setting persisted.
  Observation:

- [ ] **Theme cycle.** Click theme button or use shortcut to cycle
  light → dark → system. Editor chrome and decorations follow.
  Observation:

- [ ] **Raw-source toggle.** Press `Cmd-E`. Live-Preview transformations
  swap off (raw markdown visible, including marker tokens and the
  `![[…]]` text for embeds). Press again to swap back.
  Observation:

- [ ] **Properties UI frontmatter round-trip.** Open a file with
  frontmatter (e.g. `data/frontmatter_rich.md`). Edit a frontmatter
  value via the Properties panel. Confirm the file's text reflects
  the change without disturbing body content.
  Observation:

## 4. L3 surface (layer-3-spec §9 — Sessions B, D, E, G.1–G.3, H.1, H.2, J.2)

- [ ] **Wiki-link click cross-file.** In a file containing
  `[[OtherFile]]`, click the link. Editor opens OtherFile.md.
  Observation:

- [ ] **Heading-anchor scroll.** Click `[[OtherFile#Some Heading]]`.
  Editor opens OtherFile.md and scrolls to "Some Heading."
  Observation:

- [ ] **Block-ref creation.** Cmd-Shift-B on a line. Clipboard now
  holds `[[FileName#^id]]`; the file's line gains a trailing `^id`.
  Observation:

- [ ] **Tag click.** Click any `#tag` decoration. Virtual tag page
  opens listing files with that tag. Click a row → editor returns
  to that file.
  Observation:

- [ ] **Pending-rewrites status.** Rename a file (right-click in
  tree). Status bar shows pending-rewrites count > 0. Click it,
  flush. Count returns to 0; referrer files' wiki-links updated.
  Observation:

- [ ] **Backlinks panel.** Open the right sidebar's backlinks panel.
  Confirm it lists files that link to the currently open file.
  Click a row → navigate to that file.
  Observation:

- [ ] **Unlinked mentions panel.** Switch to the unlinked-mentions
  segment. Confirm it lists candidate mentions (files containing
  the current file's basename as plain text). Click "link" on one
  → mention becomes a `[[link]]`.
  Observation:

- [ ] **Autocomplete `[[`.** In editor, type `[[`. Dropdown lists
  files. Type letters → narrows. Enter inserts `[[selection]]`.
  Observation:

- [ ] **Autocomplete `#`.** Type `#proj`. Dropdown lists tags
  matching prefix. Enter inserts the tag.
  Observation:

## 5. L4-A surface (layer-4-spec §9.1 recipes 1–11)

> Note: these recipes use the dev console (`__TAURI__.core.invoke`)
> for now since L4-A had no UI surface. Run each from the dev console.

- [ ] **Recipe 1 — search single-term.** `search({ req: { vault_id, query: { text: 'note', fields: { kind: 'default' } } } })`.
  Hits returned, ordered by score.
  Observation:

- [ ] **Recipe 2 — field-scoped on code.** Same call, `fields: { kind: 'code_only' }`, `text: 'fn'`. Hits on `code/rust_examples.md` only.
  Observation:

- [ ] **Recipe 3 — field-scoped on headings.** `text: 'examples'`, `fields: { kind: 'headings_only' }`. Hits on rust + python examples.
  Observation:

- [ ] **Recipe 4 — field-scoped on tags.** `text: 'anything'`, `fields: { kind: 'tags', tags: ['project/cubical'] }`. Hits on `data/frontmatter_rich.md`.
  Observation:

- [ ] **Recipe 5 — fuzzy.** `text: 'tantvy'`, `fuzzy: true`, default fields. Hits on `code/python_examples.md`.
  Observation:

- [ ] **Recipe 6 — phrase + negation.** `text: '"Rust examples" -python'`. 1 hit, `code/rust_examples.md`.
  Observation:

- [ ] **Recipe 7 — index status polling.** `search_index_status({ req: { vault_id } })` immediately after vault open returns `state: "building"`; after ~2s returns `state: "ready"`.
  Observation:

- [ ] **Recipe 8 — rebuild index.** `search_rebuild_index({ req: { vault_id } })` → null in ~50ms; subsequent `search_index_status` → `state: "building"` then `state: "ready"`.
  Observation:

- [ ] **Recipe 9 — health.** `search_get_health({ req: { vault_id } })` returns `schema_version: 1`, `segments >= 1`, `doc_count == file count`, `disk_bytes > 0`.
  Observation:

- [ ] **Recipe 10 — watcher fan-out.** In external terminal:
  `echo "# Smoke test" > ~/Developer/sandbox/cubical-l4a-smoke/smoke_test.md`
  Within 2s, `search({ text: 'smoke' })` returns 1 hit. Then
  `rm` the file; within 2s, query returns 0 hits.
  Observation:

- [ ] **Recipe 11 — partial during build.** `search_rebuild_index`
  immediately followed by `search({ text: 'note' })`. Response has
  `still_indexing: true`, hits empty or partial. Converges as
  rescan progresses.
  Observation:

## 6. L4-A-fix targeted bug repros

- [ ] **Bug #4 (Contract 1).** Open `A.md` (contains embeds). Press
  `Cmd-E` to toggle raw-source. Confirm: literal `![[Daily]]` text
  shows; NO widget rendered over it. Toggle back; widget restored.
  Observation:

- [ ] **Bug #5 (Contract 4).** Open `A.md`. Wait ~3 seconds. Embed
  widgets render their body content (not stuck on "Loading…").
  If stuck, run the §3.3 diagnostic decision tree (this is also
  Task 6 of the implementation plan).
  Observation:

- [ ] **Bug #6 (Contract 2).** Open `A.md`. Place cursor on the
  line below an embed. Press Up arrow. Cursor lands on the line
  containing (or just above) the embed — NOT at document start.
  Observation:

## Closeout

- Operator identifier: ____________________
- Date: ____________________
- Build commit: ____________________
- Vault commit hash (if vault is under version control): ____________________
- Pass / fail summary: ____________________
- Outstanding follow-ups (file as separate issues): ____________________
