> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# UI composition refactor — substrate / feature-module / composition-root

**Date:** 2026-06-23 · **Status:** pilot landed (cheap seams), rest deferred ·
**Branch:** `feat/property-ref-interpolation` (working tree)

## Why

An SRP audit found the architecture, crate split, and `.ts`/`.tsx` separation
strong, but the UI shell (`ui/src/App.tsx`) had become a god-component that
collapsed the project's own composition commitment (CLAUDE.md non-negotiable #7,
[`foundation.md`](../../architecture/foundation.md) §1 commitment 4) back into a
monolith: 49 signals, a settings persist/seed pattern duplicated ~17×, and an
`onVaultFileChanged` handler that hand-fans one event out to 7 features.

Goal: make the existing "substrate always-on; features compose on/off" model real
in the UI, proven incrementally rather than in one big-bang.

## The model

SRP decides **where to cut** (one reason-to-change per unit); composition decides
**how to reconnect** (stable seams). The core must be a **substrate, not a hub**:
minimal, always-on, dependency arrows point *inward only* — features depend on the
substrate; the substrate never imports a feature.

| Layer | What | Rule |
|---|---|---|
| Substrate (core) | vault identity, event bus, settings side-effects, IPC, theme | knows nothing about features |
| Feature modules | backlinks, search, properties, resolvers, omni-bar, … | own their state + IPC + reaction to substrate events |
| Composition root | `App.tsx`, shrunk to wiring + layout | mounts + provides context; may reference many features, but only to wire |

## What landed (cheap seams — verified: tsc clean, 601 vitest pass)

- **`ui/src/core/vaultSession.ts`** — vault identity (`vaultId`/`vaultPath`/
  `scanStatus` + progress) extracted to the substrate as a composable. Mechanical,
  behaviour-preserving; establishes the `core/` layer.
- **`ui/src/core/settings.ts`** — `persistSetting` + `seedSetting`. Owns only the
  persist/seed *side-effects*; each setting's reactive value stays with its feature,
  preserving the typed `Setting`→`SettingValue` key safety. Removed ~10 duplicated
  persist-setters and 7 seed-on-open blocks from App.tsx. Unit-tested in isolation
  (`core/settings.test.ts`). **Note:** the `appearance.theme_mode` seed is left
  inline on purpose — themeMode is *not* reset on vault open, so it must apply only
  when the key is present (not the fallback), which `seedSetting` doesn't model.
- **`ui/src/errorMessage.ts`** — shared `errorMessage(e: unknown): string`. Collapsed
  15 copies of the `typeof e === "object" …` idiom across 6 files (incl. SearchPanel's
  private `messageOf`). Tested (`errorMessage.test.ts`).

## Deferred — remaining staged work (do as separate focused sessions)

1. **`core/vaultEvents.ts` — the event bus (HIGH VALUE, HIGH RISK).** Wrap the six
   `onVault*` listeners + vault-id filtering + own-write-echo classification
   (`isOwnWriteEcho`, currently `ui/src/ownWrite.ts`) into one substrate-owned bus.
   App and features `subscribe` instead of App dispatching. **Risk:** rewrites the
   `onVaultFileChanged` handler (App.tsx ~lines 1002–1094) that carries the delicate
   own-write suppression + conflict-banner logic (L2 §2.7/§2.8). Gate it with the
   conflict/autosave operator smoke: open a vault, edit + autosave, trigger an
   external edit on a clean vs. dirty buffer, confirm silent-reload vs. banner both
   still fire, and that own-write echoes are suppressed.

2. **`editor/resolvers.ts` — first full feature module.** Owns the wikilink/embed/
   property/dataview/autocomplete resolver lifecycle (created on vault open, cleared
   on close), invalidated by one `vaultEvents.onFileChanged(external)` subscription —
   replacing the 4-way `.invalidate()` fan-out at App.tsx ~1021–1030. Depends on (1).

3. **Remaining feature-module extractions** (one or two per session), each owning its
   own signals + logic + event reaction:
   - buffer/autosave/conflict → `editor/buffer.ts` (selectedPath/Content, seenHash/
     lastWrittenHash/dirty, performWrite, flushAutosave, conflict banner)
   - file tree/virtualization → `sidebar/fileList` composable
   - right sidebar, search-refresh, omni-bar, tag-view, broken-refs, rename/pending —
     see the full signal→module map in the approved plan.

4. **Codify the model into the architecture docs** — promote substrate/feature/
   composition-root into [`foundation.md`](../../architecture/foundation.md) §1
   commitment 4 (or a dedicated UI-architecture note) *after* the bus pilot proves
   the shape, per the project's "capture what landed, tersely, after" protocol.

5. **Rust (separate domain, out of scope for the UI work):** the same "thin handler +
   extracted orchestration" principle applies to the command god-functions
   (`crates/cubical-app/src/commands/rename.rs`, `vault.rs::write_file_text`,
   `events.rs::apply_watch_event_to_db`).

## Impact so far

App.tsx 2649 → 2569 LOC (−80); −102 net across the 6 touched files; +126 LOC of new
single-purpose production modules and +107 LOC of new tests. Total LOC is ~flat — the
win is duplication eliminated and concerns given single owners, not raw line count.
