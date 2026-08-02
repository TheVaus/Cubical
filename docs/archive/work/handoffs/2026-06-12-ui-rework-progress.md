> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# UI Rework — progress / handoff (2026-06-12)

A ground-up restructure of the app shell into a layered, Obsidian-style
UI. **Incrementally merged to `main` 2026-06-12** (work was done on branch
`feat/ui-rework`). The headless gates are green at every commit (`tsc`,
`455 vitest`, `npm run build`; no Rust changes); visual verification is by
the operator via `cargo tauri dev` (Vite HMR pushes each change live).
One increment remains: **tabs / multi-document** (the architecture fork).

## Design source
`docs/superpowers/mockups/ui-rework.html` — a self-contained interactive
mockup that captures the agreed design (open it in a browser). It is the
spec: layer model, slide-to-collapse, tabs placement, status bar, settings
modal, vault switcher, folder tree, search-over-tree layer.

## Core model
- **Stacked layers.** L0 chrome = full-width top bar + status bar. The
  editor is a fixed, centered layer; the two sidebars are **floating
  layers** (`position:absolute`) that **slide off-screen on collapse**
  (`transform`) — so collapsing **never reflows or re-renders the editor**.
  This is the load-bearing principle; preserve it.
- New stylesheet `ui/src/styles/layout.css` (uses the real design tokens;
  linked from `ui/index.html`). Most rework styling lives here.

## Done (commits `f0b06a3`…`a7c94a8`)
1. **Layout shell** — top bar (left-collapse + tabs + source toggle +
   right-collapse), stage with fixed editor + floating slide sidebars,
   full-width status bar. Right sidebar inlined (Backlinks/Mentions);
   `RightSidebar.tsx` deleted.
2. **Folder tree** — `ui/src/sidebar/fileTree.ts` (pure `buildFileTree` +
   `flattenTree`, +8 vitest) rendered through the existing fixed-height
   virtualization. Collapsible folders; files select/rename/context-menu.
3. **Editable filename title** — basename stem above the editor; editing
   renames via the existing `handleRenameCommit` pipeline. **No `# H1` is
   ever written** (filename *is* the title). Open buffer follows the
   rename (`setSelectedPath`) so repeat edits work.
4. **Status bar** — three regions: vault dir (left) · word/block counts
   (middle) · current file's vault-relative path (right); system status
   (scan/broken-refs/pending-rewrites) groups left.
5. **Settings modal** — footer ⚙ opens it. Appearance(Theme) /
   Editor(raw-source default) / Vault(path + Open another) / Shortcuts.
   Wired to real keys (`appearance.theme_mode`, `editor.raw_source_default`).
6. **Vault switcher** — left-sidebar footer: vault button (open/switch) +
   ⚙. Theme and Open Vault were removed from the top bar; the no-vault
   screen keeps an Open Vault button.
7. **Editor blend** — removed the Editor root border/box; CodeMirror
   surface transparent; centered 44rem column fills height.
8. **Color-theory pass** — fixed the modal scrim (was `--c-bg-overlay`
   5% / white-on-dark → `rgba(0,0,0,.5)`); unified segmented-control
   active states (accent restraint); light-theme `--c-fg-muted`
   `#a1a1aa`→`#71717a` for WCAG AA.
9. **Search-results-over-tree layer (increment 4)** — `SearchPanel` keeps
   the file tree mounted and renders results as an opaque absolute layer
   above it (preserves the tree's scroll + expanded folders; no
   unmount/reflow). Was previously `fallback={props.children}`.

## Remaining
- **Tabs / multi-document (increment 8) — the architecture fork.** The app
  is deliberately single-buffer today (`seenHash`/`lastWrittenHash`/
  autosave/conflict are all single-open-buffer). Real tabs = multiple
  buffers with per-tab state = a meaningful App.tsx state rearchitecture.
  Do it last, on its own, carefully. Tag-pages-as-tabs depends on it.
- **Minor:** Settings "Panels" category (right-sidebar defaults);
  autosave/pending-flush settings; consider theming the floating-sidebar
  shadow lighter for light mode.

## Key files
`ui/src/App.tsx` (shell restructure, tree wiring, title, settings, status
bar), `ui/src/styles/layout.css` (new), `ui/src/sidebar/fileTree.ts`
(+test), `ui/src/Editor.tsx` + `ui/src/editor/cm-theme.ts` (blend),
`ui/src/styles/tokens.css` (muted contrast), `ui/index.html` (css link).
