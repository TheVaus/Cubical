> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: UI

## 11. UI

### 11.1 Layout

- **Left panel:** universal '+' create button, file explorer (heights measured by Pretext, virtualized via standard list-virtualization), persistent search panel (Tantivy).
- **Central workspace:** tab bar with split-pane support, unified Live Preview editor.
- **Right sidebar:** backlinks pane and unlinked mentions pane.
- **Bottom status bar:** indexer progress, vault health (broken refs, malformed YAML), Pending Rewrites count, sync state (post-L7).

### 11.2 Global triggers

- `Cmd/Ctrl+K`: Omni-Bar for transient quick-nav and command execution.
- `[[`: in-editor link auto-complete.
- `#`: in-editor tag auto-complete (when typed at word boundary outside code blocks).
- Drag-and-drop: dropping an asset into the editor creates an inline link and triggers the deduplication pipeline.

App-level and editor keyboard shortcuts are defined in one place — the command/keymap registry (`ui/src/core/commands.ts`, L5 substrate). It owns the command types, the static binding table, and key matching; the App-level `keydown` and the CodeMirror keymap are both generated from it (single source of truth). Bindings are static in v1 — no user remapping.

### 11.3 Live Preview

There is no separate "Read mode" and "Edit mode." Live Preview is the only mode for normal use. A Raw Source toggle exists for power users who want to see the literal markdown.

Live Preview is implemented as Lezer-driven decorations on the CodeMirror state. The line the cursor is on shows raw markdown; other lines show rendered form. Cursor movement triggers decoration re-application, which is fast because Lezer parsing is incremental.

### 11.4 Theming

The canonical CSS-variable token surface lives in `design-system/src/styles/tokens.css`; the app's `ui/src/styles/tokens.css` re-exports it (a single `@import`, plus nothing of its own), so editing a value in the design system propagates to every instance in the app. **All UI components consume tokens; no hardcoded colors, fonts, or spacings exist outside the token surface.** This is enforced by lint rule. See §11.6 for the design system's role as the app's component library.

**Token categories:** colors (`--c-bg-primary`, `--c-fg-primary`, `--c-accent`, `--c-success`, `--c-warning`, `--c-error`, …), typography (`--font-body`, `--font-mono`, `--text-base`, `--leading-base`, …), spacing scale (`--space-1` through `--space-8`), border radii, shadows.

**Built-in themes** ship with the app: Light, Dark, optionally High-Contrast.

**User themes** live at `<vault>/.cubical/themes/<theme-name>.css`. Cubical scans this folder on startup and populates the theme picker.

**Plugin themes** are registered via the plugin manifest's `themes` field. They plug into the same token surface — they are CSS files that override token values.

**CodeMirror integration.** The CM6 theme is generated programmatically from the same token surface. Authors write themes against tokens; the editor stays in sync with the rest of the UI without a second theme to maintain.

**Live theme switch.** Setting `<html data-theme="...">` triggers a CSS-variable cascade. No reload, no flicker.

### 11.5 Multi-vault

**One vault per window, multiple windows allowed.** A single Tauri process holds `HashMap<VaultId, Vault>` in Rust state. Each window's frontend tracks one `vault_id` and uses it in all IPC commands. Users with multiple vaults open multiple windows.

Cross-vault search, cross-vault tabs, and cross-vault command-palette are explicitly out of scope — most users don't ask for them, and the implementation cost is significant. The IPC contract leaves the door open if user demand emerges later.

### 11.6 Component library

The app's UI primitives are **not** hand-rolled in `ui/` — they come from the shared design system at [`design-system/`](../../design-system/), consumed through the `@ds` alias (wired in `ui/vite.config.ts` + `tsconfig`, with `dedupe: ["solid-js"]` keeping a single Solid instance across the boundary). `design-system/` is the single source of truth for **tokens and components**: editing a component or token there changes it everywhere in the app. The design system also stands alone as its own SolidJS package with a Gallery/Workspace playground — see [`design-system/README.md`](../../design-system/README.md).

**Icons** come from the design system's `Icon` component (`components/graphics/Icon`), backed by a registry of SVG artwork **vendored inline from Lucide** (ISC-licensed). No runtime icon dependency ships — consistent with self-containment; `lucide-static` is a build-time source only. Icons render outline-only on a 24-unit grid at 16px by default via `currentColor`, decorative by default (the accessible name comes from the wrapping control). Conventions + how to add one: [`design-system/README.md`](../../design-system/README.md) → Iconography.

Two locked rules govern how it grows:

- **Extend additively.** When a component lacks a prop the app needs, add it to the design system and default it to the component's prior behavior — never fork the component or work around the gap app-side.
- **Components are self-contained.** A design-system component may not depend on the playground's global stylesheets (its `base.css` control reset or `layout.css` utilities); it sets its own control reset and layout in its own CSS. The app imports neither global.

Some surfaces stayed **deliberately bespoke** where no design-system component fit at migration time — but that set has since shrunk. Issue #35 authored the net-new primitives that unblocked most of them: `Select` (the native `<select>`s), `DatePicker` (the native date pickers), `Popover` (the VaultSwitcher / Pending Rewrites / set-info positioned dropdowns), `Link` (the "Open as raw" text links), and a richer pill `Tag` (ChipList's multi-control chips) — all merged 2026-07-19 — plus `TwoPaneModal` (the nav+body Settings modal), merged 2026-07-20. One surface remains bespoke, awaiting the last net-new primitive still parked in #35: the ranked multi-kind **OmniBar** palette (needs a richer `CommandPalette` — the flat `{id,label,onRun}` DS one would regress its fuzzy rank, kind badges, and recency). The migration record and the full bespoke rationale live in the campaign handoff [`../superpowers/2026-07-17-ds-migration-progress.md`](../superpowers/2026-07-17-ds-migration-progress.md); the net-new-primitive backlog (6 done, 1 remaining) is GitHub issue #35, and the deferred migratable inline tail is #34.

---

## 12. Settings

User-facing settings, organized by category:

**Files & Core.** Vault path. `.cubical/recovery/` retention window (default 30 days). Pending Rewrites flush cadence (default 5 min). Auto-save debounce (default 300ms). Asset destination is locked to `.assets/` (not configurable).

**Editor & Export.** Live Preview vs Raw Source default. Export sanitization rules (display only — sanitization is mandatory).

**Appearance.** Theme picker (built-in + user themes from `<vault>/.cubical/themes/` + plugin-distributed themes). Font family, font size overrides.

**Search.** Tantivy indexing controls.

**Sync & Network.** (L7+) Local P2P toggle, E2EE key generation and management, relay configuration.

**Plugins & Security.** (L6+) Per-plugin WASI permission toggles.

**Time Machine.** (L8+) Snapshot retention window, manual snapshot trigger.
