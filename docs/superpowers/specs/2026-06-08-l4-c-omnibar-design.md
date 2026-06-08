# L4-C — `Cmd/Ctrl+K` Omni-Bar (design)

> Status: approved 2026-06-08. Layer 4, Session C. A keyboard-summoned
> fuzzy navigator over **notes + tags**. Consumes L4-A/L3 data; adds one
> tiny IPC (`list_tags`). This spec feeds `superpowers:writing-plans`;
> implementation is TDD per `docs/conventions.md`.

## 1. Goal

A transient modal — opened with `Cmd/Ctrl+K` from anywhere a vault is
open — that lets the user **jump to a note or tag by name**, entirely
from the keyboard. Type → a single fuzzy-ranked list of notes and tags
updates live → ↑/↓ select → Enter navigates → Esc closes.

This is a **navigator**, not a content search. It complements the L4-B
search panel (full-text "where is this written?"); the Omni-Bar answers
"take me to *X* now." Keeping the two surfaces distinct is a deliberate
UX decision (see §2).

## 2. Decisions (locked in brainstorming, 2026-06-08)

1. **Sources — notes + tags only for v1.** Headings and commands are
   deferred. Headings have no addressable index today (they live only in
   Tantivy's concatenated `headings` field and in on-the-fly anchor
   resolution; the libSQL `blocks` table is `^block-id`-only), so a
   clean per-heading jump target needs a new index — out of scope here.
   Commands need a command registry the app doesn't have. Both are
   future work.
2. **Approach A — client-side fuzzy over in-memory sources.** Notes come
   from App's already-in-memory file list; tags from a one-time
   `list_tags` fetch cached in App. A pure `ranker.ts` fzf-style scorer
   ranks the merged list. Rationale: vaults fit in memory (the sidebar
   already holds the file list), so ranking is instant with no
   per-keystroke IPC, and client-side subsequence matching is **genuinely
   typo-tolerant** — it sidesteps the L4-A backend's title-only fuzzy
   limitation entirely. The ranker stays a pure, unit-testable unit
   (matches `docs/layer-4-spec.md` §4: `ranker.ts — fuzzy ranking over
   heterogeneous sources`).
3. **Unified ranked list**, not grouped-by-kind. One list, best match
   first regardless of kind, each row carrying a kind badge. Faster
   keyboard nav and more direct cross-kind ranking than sections.
4. **Empty state = recent notes.** Before any query, show the most
   recently modified notes (top 10 by mtime). Research-backed
   ("recent-first variant when repeat use matters") and makes the bar a
   useful "jump back" switcher immediately. Tags appear only once the
   user types.
5. **Always hand off, never act in-place.** Enter navigates and closes —
   no inline editing/actions in the bar. A clean palette↔app boundary
   (Obsidian-style document-focus handoff).
6. **No visible `⌘K` affordance in v1.** Discoverability via a visible
   hint was considered; skipped to keep L4-C self-contained and avoid
   touching the just-tagged L4-B search bar. Noted as a trivial
   follow-up (§11).

These reflect command-palette best practice (keyboard-completable,
fuzzy + match highlighting, recent-first empty state, subtitle/kind
labels not color-alone, planned empty/error states, search-vs-command
separation, real a11y semantics). Sources: solomon.io
"Designing Command Palettes"; uxpatterns.dev "Command Palette Pattern";
pencilandpaper.io "Search UX Best Practices".

## 3. Sources & data model

```ts
// ui/src/omnibar/types.ts (or co-located in ranker.ts)
export type OmniItem =
  | { kind: "note"; title: string; path: string }  // title = filename stem
  | { kind: "tag"; tag: string };                   // tag path, no leading '#'
```

- **Notes:** derived from App's `files()` (markdown entries). `title` =
  filename stem (`Red King.md` → `"Red King"`); `path` kept for the
  subtitle and as the navigation target. Matching is on `title` only
  (path is shown, not fuzzed, to keep ranking clean).
- **Tags:** the deduplicated vault tag set from `list_tags`, fetched once
  on first open, cached in App state, invalidated on the existing
  vault-content `refreshSignal`.

## 4. New IPC — `list_tags`

The only backend code in L4-C. `tag_autocomplete("")` returns only a
capped first page, so it can't feed client-side fuzzy over the full set.

- **Command:** `list_tags { vault_id } -> { tags: string[] }` in
  `crates/cubical-app/src/commands/` (alongside `tag_autocomplete`).
- **Query:** `SELECT DISTINCT tag_path FROM tags ORDER BY tag_path`
  against the open vault's libSQL index. `tag_path` is stored
  case-as-written (no leading `#`); return it verbatim to preserve the
  user's display casing (the tags table comment is explicit that
  case-insensitive *matching* is the query/UI layer's job — the ranker
  handles that with case-insensitive subsequence matching). `DISTINCT`
  dedupes the `(file, tag, source)` triples down to one row per tag.
- **Registration:** add to the Tauri `invoke_handler`; TS wrapper
  `listTags(req)` + `ListTagsRequest`/`ListTagsResponse` types in
  `ui/src/api/ipc.ts`.
- **Tests (Rust, `cubical-app`):** distinct + sorted output; empty vault
  → `[]`; dedupes a tag carried by multiple files.

## 5. Ranker — `ui/src/omnibar/ranker.ts` (pure; the heart)

```ts
export interface RankedItem {
  item: OmniItem;
  score: number;
  /** indices into the matched text (title|tag) for highlight rendering. */
  matchedIndices: number[];
}
export function rankItems(query: string, items: OmniItem[], limit: number): RankedItem[];
```

- **Matching:** case-insensitive **subsequence** of `query` against the
  item's match text (`title` for notes, `tag` for tags). If the query
  chars do not all appear in order, the item is excluded.
- **Scoring (fzf-style), higher is better:** reward (a) contiguous runs
  of matched chars, (b) matches at boundaries — start of string, after a
  space/`/`/`-`/`_`, or a camelCase upper — and (c) an earlier first
  match and (d) a shorter target. Exact prefix and full exact match get
  large bonuses.
- **Order:** score desc; ties broken by shorter target, then notes
  before tags, then alphabetical — deterministic.
- **Empty query:** the ranker is only invoked for non-empty queries. The
  empty-query "recent notes" list is computed in App (it needs `mtime`,
  which `OmniItem` deliberately doesn't carry) and passed to `OmniBar` as
  `recentNotes`; the component shows that list verbatim when the query is
  empty.
- **Cap:** return at most `limit` (default 50).
- **Pure & total:** no IO, no globals; same input → same output.

## 6. Modal — `ui/src/omnibar/OmniBar.tsx`

Follows the existing dialog pattern (`App.tsx` create-offer / Properties
overlays): fixed full-viewport backdrop (`rgba`), a centered card in the
upper third, click-away + Esc to close. **Operator-smoke-only** per
Contract E (no Solid render lib) — all logic lives in `ranker.ts`.

- **Props:** `{ open, items: OmniItem[], recentNotes: OmniItem[],
  onClose, onOpenNote(path), onOpenTag(tag) }`.
- **State:** `query` signal; `selectedIndex` signal; a `createMemo`
  ranked list (`rankItems` when query non-empty, else `recentNotes`).
- **Rendering:** an auto-focused input; a `listbox` of `option` rows.
  Each row: a **kind badge** (a document glyph for notes, `#` for tags —
  icon/text, never color-alone), the name with matched chars
  highlighted (`<mark>` via `matchedIndices`, no `innerHTML`), and for
  notes the `path` as a muted subtitle. Selected row visually
  highlighted; list capped (top ~50); `min-width: 0` truncation so long
  paths don't blow out the card.
- **Keyboard:** ↑/↓ move selection (clamped, not wrapping); Enter
  activates the selected row; Esc closes; typing re-ranks. Mouse hover
  sets selection, click activates.
- **Reset:** opening clears `query` and resets `selectedIndex` to 0;
  selection re-clamps to 0 whenever the ranked list changes.

## 7. App wiring (`App.tsx`)

- **Global hotkey:** a `window` `keydown` listener — `(e.metaKey ||
  e.ctrlKey) && e.key === "k"` → `preventDefault()` and toggle the bar
  open. No-op when no vault is open. Registered in an `onMount`, removed
  in `onCleanup` (mirrors existing global-key handling).
- **Tag cache:** an App `tags()` signal, lazily loaded via `listTags` the
  first time the bar opens (and re-fetched when `refreshSignal` changes).
  `list_tags` failure → log + fall back to notes-only (bar still works).
- **Items:** notes mapped from `files()` + tags from `tags()`, merged
  into `OmniItem[]` and passed to `OmniBar`. `recentNotes` = `files()`
  sorted by mtime desc, top 10, mapped to note items.
- **Navigation:** `onOpenNote(path)` → `handleNavigateWikilink(path,
  null)`; `onOpenTag(tag)` → the existing tag-page navigate. Both close
  the bar after dispatching. Reuses the autosave-safe selection path.

## 8. Accessibility

Keyboard *is* the primary mode, so a11y is core, not a pass:

- `role="dialog"` + `aria-modal="true"` on the card; an accessible label
  on the input.
- The result list is `role="listbox"`; rows are `role="option"` with
  `aria-selected`. The input carries **`aria-activedescendant`** pointing
  at the selected option's id (so the active row is announced without
  moving DOM focus off the input).
- **Focus management:** focus the input on open; **restore focus** to the
  previously-focused element on close.
- Result count surfaced for assistive tech (e.g. an `aria-live` or a
  visible "N results" line).
- Selection indicated by more than color (a left bar / weight change).

## 9. Empty / loading / error states (one container)

- **Empty query:** "Recent notes" — the recentNotes fallback list.
- **No match:** an explicit "No notes or tags match" row.
- **Empty vault:** "No notes yet."
- **Tag fetch failed:** silently degrade to notes-only (logged).

## 10. Testing

- **`ranker.test.ts` (vitest, extensive):** subsequence match/no-match;
  ranking order (contiguity, boundary, prefix, exact bonuses);
  `matchedIndices` correctness; case-insensitivity; tie-breaks
  (shorter → note-before-tag → alpha); cap; empty/whitespace query;
  unicode-safe indexing.
- **`list_tags` (Rust, `cubical-app`):** distinct + sorted; empty vault;
  multi-file dedupe.
- **IPC wrapper type-shape smoke** (vitest), consistent with
  `ui/src/api/search.test.ts`.
- **`OmniBar.tsx`:** operator-smoke-only (Contract E); recorded in the
  L4-C §9 closeout of `docs/layer-4-spec.md`.

## 11. Out of scope (deferred)

- **Headings** as jump targets (needs a headings index — own session).
- **Commands / command palette** (needs a command registry).
- **"Create note if no match"** (Obsidian-style new-note offer).
- **Scoped prefixes** (e.g. leading `#` to force tags-only).
- **Context-awareness** (suggesting actions by current view) — the
  command-palette "superpower"; belongs with the deferred commands work.
- **Visible `⌘K` discoverability hint** in the search bar — trivial
  follow-up, intentionally not in v1.
- **Preview pane** for the selected note.

## 12. File touch-list & Definition of Done

**New:**
- `crates/cubical-app/src/commands/…` — `list_tags` command (+ tests)
- `ui/src/omnibar/ranker.ts` + `ranker.test.ts`
- `ui/src/omnibar/OmniBar.tsx`
- (maybe) `ui/src/omnibar/types.ts`

**Modified:**
- `crates/cubical-app/src/lib.rs` (or wherever the invoke_handler lives) — register `list_tags`
- `ui/src/api/ipc.ts` (+ `search.test.ts`-style shape smoke) — `listTags` wrapper + types
- `ui/src/App.tsx` — hotkey, tag cache, render `OmniBar`, navigation callbacks
- `docs/layer-4-spec.md` — §6 L4-C tick, §9.4 closeout
- `CLAUDE.md` — project state

**DoD:** Omni-Bar opens on `Cmd/Ctrl+K`, fuzzy-ranks notes+tags with
highlighted matches, keyboard-navigates, opens the target and closes;
recent-notes empty state; a11y semantics in place; `list_tags` landed
with tests; all six gates green (`cargo test`/`clippy`/`fmt`, `tsc`,
`vitest`, `build`); operator smoke recorded; merged to `main` and tagged
`l4c`.
