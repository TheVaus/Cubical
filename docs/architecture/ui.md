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

App-level and editor keyboard shortcuts are defined in one place — the command/keymap registry (`ui/src/core/commands.ts`, L5 substrate). It owns the command types, the default binding table, and key matching; the App-level `keydown` and the CodeMirror keymap are both generated from it (single source of truth). Users rebind from Settings → Shortcuts: the defaults are the extension point, and only the diff is persisted per-vault as `shortcuts.overrides`. The registry stays pure — it imports nothing from any feature, and the adapters inject the `run` closures.

### 11.3 Live Preview

There is no separate "Read mode" and "Edit mode." Live Preview is the only mode for normal use. A Raw Source toggle exists for power users who want to see the literal markdown.

Live Preview is implemented as Lezer-driven decorations on the CodeMirror state. The line the cursor is on shows raw markdown; other lines show rendered form. Cursor movement triggers decoration re-application, which is fast because Lezer parsing is incremental.

**Fenced blocks are rendered from a registry, not from per-language code.** A block type — `query`, `csv`, `math` — is a registered renderer keyed by its info string, and adding one must not mean adding another decoration field. This is the seam the plugin block API ([#61](https://github.com/TheVaus/Cubical/issues/61)) is expected to land on, so it is deliberately data-shaped ahead of that ABI; it carries no sandbox and grants nothing, and a third-party renderer cannot use it until the ABI exists.

Syntax that is **not** a fenced block cannot go through the registry, because the registry is keyed on the fence info string. `$$…$$` display math is the worked example: it is a scanner of its own over the document text, reusing the same renderer and frame. Anything wanting non-fence syntax pays that cost, which is the reason to prefer a fence.

Display math occupies **whole lines**, so a mid-line `$$…$$` stays literal text. That is a consequence of the block-replace shape, not an oversight: rendering mid-line would need an inline widget, which is a recorded failure — see [`../implementation/frontend.md`](../implementation/frontend.md), "Block widgets and the cursor". Inline `$…$` math is unbuilt for the same reason.

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

**This section is prose, not the allowlist.** The machine-readable per-file budgets for raw controls live in `scripts/ds-raw-controls.json`, which `scripts/gates/ds_components.py` reads — one source, two readers. That separation exists because this section described *one* bespoke surface while 17 raw controls existed across 6 files; the prose was right about the exception and silent about the debt.

Some surfaces stayed **deliberately bespoke** where no design-system component fit at migration time — but that set has since shrunk. Issue #35 authored the net-new primitives that unblocked most of them: `Select` (the native `<select>`s), `DatePicker` (the native date pickers), `Popover` (the VaultSwitcher / Pending Rewrites / set-info positioned dropdowns), `Link` (the "Open as raw" text links), and a richer pill `Tag` (ChipList's multi-control chips) — all merged 2026-07-19 — plus `TwoPaneModal` (the nav+body Settings modal), merged 2026-07-20. One surface remains bespoke, awaiting the last net-new primitive still parked in #35: the ranked multi-kind **OmniBar** palette (needs a richer `CommandPalette` — the flat `{id,label,onRun}` DS one would regress its fuzzy rank, kind badges, and recency). The migration record and the full bespoke rationale live in the campaign handoff [`../archive/work/handoffs/2026-07-17-ds-migration-progress.md`](../archive/work/handoffs/2026-07-17-ds-migration-progress.md); the net-new-primitive backlog (6 done, 1 remaining) is GitHub issue #35, and the deferred migratable inline tail is #34.

A second surface is bespoke by construction rather than by backlog: the **graph hover label** (`ui/src/graph/GraphView.tsx`). `Tooltip` and `Popover` both anchor to a child element, and a node drawn at canvas coordinates is not one — there is no element to anchor to. It is a plain positioned `div`, uses only DS tokens, and would become migratable only if the DS gained a primitive that anchors to a point rather than to a child.

### 11.7 App composition

§11.6 governs where a *primitive* comes from. This section governs what `ui/src` is made of.

**`ui/src/App.tsx` is a composition shell.** It holds vault identity, the tab set, the global keydown table and the JSX that arranges features — and nothing a feature could own. State lives with the feature that reads it, in a folder under `ui/src/`: `explorer/`, `workspace/`, `settings/`, `sidebar/`, `statusbar/`, `omnibar/`, `tabs/`, `terminal/`, `viewer/`, `editor/`. A feature folder holds its own markup, its own state factory, and the pure logic beside them as a unit-testable `.ts`.

Two shapes are already the convention and stay it: pure logic is a `.ts` next to its `.tsx` with its own test (`tabs/tabModel.ts`, `omnibar/ranker.ts`, `navHistory.ts`, `virtualList.ts`), and stateful wiring is a `create*` factory (`core/vaultSession.ts`, `terminal/wiring.ts`, `settings/settingsState.ts`).

**The shell may not call IPC.** Features do. This is what keeps the rule from decaying into a line count — a feature can be added to `App.tsx` in fewer lines than any cap would notice, but not without an IPC call.

Enforced by `scripts/gates/composition.py`. **This section is prose, not the allowlist:** the per-file budgets, the shell's state cap and its import waivers live in `scripts/component-budgets.json`, which the gate reads — one source, two readers, the same separation §11.6 uses for raw controls. The rule and its rationale are owned by [`../principles/component-composition.md`](../principles/component-composition.md); the decision to make it a rule at all is recorded in issue #85.

---

## 12. Settings

The **shipped** Settings modal is tab-based. The authoritative list of tabs is
`SETTINGS_TABS` in `ui/src/settings/tabs.ts`, and the authoritative list of setting *keys*
is the `Setting` union in `ui/src/api/ipc.ts` — the frontend's typed view of a
deliberately generic backend config table. Neither is restated here: a doc that
mirrored either would rot every time a toggle shipped, and did.

Locked product decisions about settings, which are what this section owns:

- Asset destination is locked to `.assets/` and is **not** user-configurable.
- Export sanitization is **mandatory**; only its rules are surfaced for display.
- Categories reserved for later layers: per-plugin WASI permission toggles (L6),
  local P2P / E2EE keys / relay configuration (L7), Time Machine snapshot
  retention (L8).

### 12.1 Where a setting is stored — routing is by key prefix

Two tiers, per [`vault.md`](vault.md) §3: `config.toml` is durable and travels
with the vault; the libSQL `config` table is transient, per-machine workspace
state. The tier is chosen by a **literal key prefix** — any key beginning `ui.`
is routed to the index, everything else to `config.toml`
(`cubical_core::vault::settings::is_workspace_key`).

This is a silent trap: naming a durable preference `ui.something` compiles, type-checks,
passes tests, and quietly makes the setting per-machine and non-portable. Choosing
the prefix chooses the storage.
