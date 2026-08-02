> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Design — Embed re-render scroll-jump fix (own-write invalidation)

**Status:** approved 2026-06-06. Focused bug-fix, gated before L4-B per
`docs/layer-4-spec.md` §9.2. Kickoff:
`docs/superpowers/2026-06-06-embed-invalidation-scroll-fix-kickoff.md`.

## Problem

While typing in a markdown file that contains a rendered embed (`![[X]]`
on its own line, shown as a card), the editor **viewport occasionally
jumps to the top** of the document. The **text cursor stays in place** —
this is a scroll/anchor jump, not a cursor bug. It is intermittent and
tracks the autosave cadence (~300 ms debounce).

## Root cause (confirmed in code)

In `ui/src/App.tsx`, the `onVaultFileChanged` handler (≈ lines 758–829)
calls both `wikilinkResolver()?.invalidate()` and
`embedResolver()?.invalidate()` **unconditionally** near the top
(≈ lines 765 / 770), *before* the own-write suppression check at
≈ line 801 (`if (incoming === lastWrittenHash) return;`, which today
only guards the conflict-banner / silent-reload logic).

Sequence: you type → autosave writes the open file → the OS watcher
reports that **own write** back as a `vault:file-changed` event → the
unconditional `embedResolver().invalidate()` clears the whole embed
cache and bumps `EmbedResolver.version()`
(`ui/src/editor/embedResolver.ts`) → every rendered embed widget
remounts and re-fetches, collapsing to its `estimatedHeight` (~60 px,
`ui/src/editor/embed.ts`) and re-expanding → that height thrash above
the cursor makes CodeMirror 6 re-anchor the viewport (the jump to top).
The adjacent `wikilinkResolver().invalidate()` has the same
unconditional shape but is far less visible (wiki-link decorations
don't thrash height).

Pre-existing — the unconditional invalidate is L3 Session H.2; the
`l4a-fix` block-card rendering + `version()`-driven remount amplified
its visibility.

## Approach (Option 1 of the kickoff — chosen)

Skip resolver invalidation on the open file's **own autosave echo**.
Changes to *other* files, and genuine *external* edits to the open file,
still invalidate exactly as before.

**Why this is correct and sufficient:** an own write to the open file
cannot change another file's content, so cached embed / wiki-link
resolutions for other targets stay valid across the echo. And a
brand-new embed you just typed resolves on demand from a *cold* cache —
`invalidate()` only drops *existing* entries, so skipping it never
blocks a new embed from resolving. The only entries we decline to drop
on an own-write echo are ones that were already valid.

Option 2 (a targeted `invalidate(path)` resolver method) was considered
and rejected for this bug: it is a real resolver API change with more
surface and test burden, and it fixes nothing Option 1 misses here.

## Components

### 1. `ui/src/ownWrite.ts` (new) — pure decision helper

```ts
export function isOwnWriteEcho(p: {
  changedPath: string;
  selectedPath: string | null;
  incomingHash: string | null | undefined;
  lastWrittenHash: string | null;
}): boolean;
```

Returns `true` iff `changedPath === selectedPath`, `incomingHash` is
present (non-empty), and `incomingHash === lastWrittenHash`. No Solid /
CodeMirror dependencies — a pure function, unit-testable without a DOM.

This mirrors the semantics of the existing own-write suppression at
`App.tsx:801` (`incoming === lastWrittenHash` *after* the `p.path !==
selectedPath()` and `!incoming` guards), but lifts the decision to a
named, testable unit and makes it available *before* the invalidate
calls.

### 2. `ui/src/App.tsx` — handler wiring

Near the top of `onVaultFileChanged`, after the `vault_id` guard and
`scheduleRefresh()`, compute the echo flag once and guard only the two
resolver invalidations:

```ts
const ownWrite = isOwnWriteEcho({
  changedPath: p.path,
  selectedPath: selectedPath(),
  incomingHash: p.new_content_hash,
  lastWrittenHash,
});

// Skip resolver invalidation on the open file's own autosave echo —
// it can't have changed any other file's content, so cached embed /
// wiki-link resolutions stay valid, and a fresh resolver invalidate
// here only thrashes embed-card height (viewport jump). External edits
// and other-file changes still invalidate below.
if (!ownWrite) {
  wikilinkResolver()?.invalidate();
  embedResolver()?.invalidate();
}
```

Everything else in the handler is unchanged: `scheduleRefresh()`, the
right-sidebar / broken-block-ref / tag refreshers, and the
external-edit branch (the `p.path !== selectedPath()` early return, the
`!incoming` guard, the `incoming === lastWrittenHash` suppression, and
the dirty-vs-clean conflict/reload logic) all keep running exactly as
before.

The existing `if (incoming === lastWrittenHash) return;` at line 801 is
left in place rather than folded into the helper — keeping the
conflict-logic path visually intact and the diff minimal. At that point
in the flow it is equivalent to `ownWrite` (the guards above it already
established `p.path === selectedPath()` and a present `incoming`).

## Testing

### Unit — `ui/src/ownWrite.test.ts` (new, vitest)

Five cases over `isOwnWriteEcho`:

1. **own-write echo** — `changedPath === selectedPath`,
   `incomingHash === lastWrittenHash` (both present) → `true`.
2. **different file changed** — `changedPath !== selectedPath` → `false`.
3. **open file, no hash** — `incomingHash` null/empty → `false`.
4. **open file, external edit** — hashes present but differ → `false`.
5. **no prior write** — `lastWrittenHash === null` → `false`.

jsdom has no layout engine, so the scroll behaviour itself is not
unit-testable; these tests pin the *decision*, the smoke pins the
*effect*.

### Executed interactive smoke (Contract E — required before any tag)

`cargo tauri dev`, open `~/Developer/sandbox/cubical-l4a-smoke/` (A.md /
B.md / C.md carry own-line embeds):

1. Type continuously for ~30 s in a file with a rendered embed — confirm
   the viewport no longer jumps and the embed stays rendered (does not
   flicker to `Loading…` / collapse).
2. From another terminal, `echo` an external edit into the open file —
   confirm the embeds still refresh (live-refresh substrate intact, no
   regression).

If a jump persists after step 1 (the kickoff's "verify, don't assume"
note), instrument with a dev-only update listener logging
`scrollDOM.scrollTop` + embed remount events **before** adding any
further fix. Do not reach for an `estimatedHeight` height-preservation
lever unless evidence shows this guard is insufficient.

## Out of scope

- The other refreshers in the handler (right sidebar, broken block
  refs, tag view) — they don't cause the jump and skipping them could
  alter refresh semantics.
- Any resolver API change (`invalidate(path)`) — Option 2, rejected.
- `EmbedWidget.estimatedHeight` height preservation — secondary lever,
  only if smoke shows the guard alone is insufficient.

## Definition of done

- Typing in a file with a rendered embed no longer jumps the viewport.
- External edits to the open file still refresh embeds.
- Six gates green at the commit boundary: `cargo test --workspace`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --all --check`, and in `ui/`: `npx tsc --noEmit`,
  `npm run build`, `npx vitest run`.
- Executed smoke recorded.
- `docs/layer-4-spec.md` §9.2 "Known issue (deferred)" updated to
  "resolved" with the fix summary; the "Known issue" line removed from
  `CLAUDE.md` Project state.
- Land on `main`; optional `l4a-fix.1` tag (operator's call).
