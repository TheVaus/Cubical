# Kickoff — finish L4-B, then the rename/pending-rewrites architecture decision

> Copy everything under the horizontal rule into a fresh Cubical session
> as the opening message. Two distinct threads: (A) close out L4-B
> (mechanical — re-smoke + one small fix, then merge/tag) and (B) a
> deliberate **architecture decision** about rename ↔ wikilink sync for
> the agent-host future (brainstorm first, do NOT just code it).

---

You are continuing Cubical. Read `CLAUDE.md` first (non-negotiables,
session protocol). All work happens in the single checkout on branches —
**never** `git worktree`. Six gates green at every commit boundary:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, and in `ui/`: `npx tsc
--noEmit`, `npm run build`, `npx vitest run`. End commit messages with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Contract E:
executed interactive smoke before any tag.

## State of the project

- **Branch `feat/l4b-search-panel`** holds all L4-B work (22 commits
  ahead of `main`), **not merged, not tagged**. All six gates green:
  **470 Rust + 422 vitest** at last sweep.
- Untracked, ignore for this work: `.superpowers/` (brainstorm
  artifacts) and `docs/superpowers/plans/2026-06-06-agent-workflow-docs-adoption.md`
  (a parked, unrelated plan).
- Design spec: `docs/superpowers/specs/2026-06-07-l4b-search-panel-design.md`.
  Plan: `docs/superpowers/plans/2026-06-07-l4b-search-panel.md`.
  Closeout + smoke checklist: `docs/layer-4-spec.md` §9.3.

### What L4-B built (the search panel) + everything that landed after first smoke

Persistent search bar above the file tree (left column); `SearchPanel.tsx`
shows the file tree below 3 chars and replaces it with results at/over 3;
sort+scope live in a **filter popover** right of the bar; virtualised
fixed-height result rows reuse `computeWindow`; `<mark>`-highlighted
snippets + relative recency; polled `search_index_status` "Indexing…"
banner; click navigates via `handleNavigateWikilink`. Pure logic
unit-tested (`debounce`/`snippet`/`searchQuery`/`relativeTime`); the
component is operator-smoke-only (no Solid render lib; Contract E).

§5 deviation #1 resolved (option a): `cubical-search` stores
`headings`/`body`/`code`/`frontmatter` and bumped `SCHEMA_VERSION 1→2`
(auto wipe+rebuild) so snippets cover every field.

Bugs found + fixed during iterative operator smoke (all committed):
1. **Intermittent "not found":** the panel sent `fuzzy:true`; L4-A
   rewrites single-term (≥4-char) default-scope queries to `title`-only
   fuzzy, discarding the multi-field search. Fixed: `buildSearchQuery`
   sends `fuzzy:false` (Rust guard
   `single_term_default_fuzzy_is_title_only_known_limitation`).
2. **Prefix / search-as-you-type:** Tantivy matched whole stemmed tokens
   only (`hihiihhiihhi` missed `hihiihhiihhii`). Fixed by OR-ing the
   parser query with a **prefix-expansion** query (expand each prefix
   against the live term dictionary into `TermQuery` leaves so matching
   *and* `SnippetGenerator` highlighting both work; the parser ignores a
   trailing `*`).
3. **Results didn't live-refresh** on content change. App now bumps a
   debounced `searchRefreshTick` on `vault:file-changed` and after the
   open file's own autosave (own-write-suppressed event); SearchPanel
   re-runs its active query (deferred, only while searching).
4. **Rename left the index stale** (old filename kept appearing):
   `rename_file` rekeyed every libSQL table but never touched search.
   Fixed: rename now drops the old path's doc + indexes the new path +
   commits, synchronously.
5. **Index accumulated orphans** (files renamed/deleted while not
   watching). Added `SearchIndex::retain_paths(keep)` and the scan
   reconciles after the walk (skipped under cancellation). Self-heals.

## Thread A — close out L4-B (mechanical)

1. **Implement the one remaining small fix first (read-only, in scope):**
   the **open-editor-buffer wikilink staleness**. After an in-app rename,
   a *referrer file already open in the editor* still shows the old
   `[[token]]` (broken) until the deferred flush, because
   `materialize_on_read` only runs on a *read* and the open buffer isn't
   re-read (the rename doesn't change that file on disk → no
   `vault:file-changed` for it). Backend coalescing is correct and the
   DB link rows are repointed at rename time — this is purely the live
   buffer. **Fix (decided, respects the design, adds zero writes):** on
   `vault:pending-rewrites-changed`, if the open buffer is clean
   (`!dirty` and no conflict), silently re-read `selectedPath`
   (`read_file_text` materializes) and replace editor content **only if
   it changed** (avoid cursor disruption). Mirror the existing
   silent-reload in `App.tsx`'s `onVaultFileChanged`. Do NOT force a
   flush, do NOT rewrite referrers — that is the write-amplification the
   L3 design deliberately avoids. This is editor state → operator-smoke
   only; keep it minimal.
2. **Run + record the L4-B re-smoke** (`cargo tauri dev`), per
   `docs/layer-4-spec.md` §9.3 "RE-SMOKE REQUIRED": per-field matches
   found + highlighted (plain single words now work); prefix matching
   (`hihiihhiihhi` finds the note); live-refresh after editing a note;
   rename keeps search + open-buffer links in sync (the new fix);
   one-time rebuild after the version bump; the pending `open_vault`
   re-open `LockBusy` smoke (`docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md`)
   + flip its CLAUDE.md "smoke pending" line; search-bar UX incl. fixed
   width; virtualised scroll + navigation; indexing banner; ~2-3× disk;
   L4-A recipes 1–11 against `~/Developer/sandbox/cubical-l4a-smoke/`.
3. **Then:** tick §6 L4-B + the session-close gate rows in
   `docs/layer-4-spec.md`, rewrite the CLAUDE.md Project state, use
   `superpowers:finishing-a-development-branch` to merge to `main`, and
   tag `l4b` — tag only after the executed smoke (Contract E).
4. Follow-up chip already filed: keyboard nav for search result rows
   (`task_bd4e47f4`).

## Thread B — rename ↔ wikilink sync: architecture decision (brainstorm first)

This came up because in-app rename leaves referrer `[[links]]` visibly
out of sync until the deferred flush. The read-only fix in Thread A
patches the *open-buffer symptom*. The underlying **architecture** is a
separate, deliberate decision — **do not just change the flush behavior**;
the operator explicitly wants the coalescing protected. Use
`superpowers:brainstorming` → a design spec under
`docs/superpowers/specs/` → plan → TDD, and treat it as an
architecture change (surface it, get sign-off) per CLAUDE.md.

**Current design (L3 Session J):** rename is instant — it updates libSQL
tables and **enqueues** referrer text rewrites into `pending_rewrites`;
disk rewrites are **coalesced** and flushed later (4 triggers: 300s
timer, app-close, >50-per-file fuse, manual). `materialize_on_read`
applies pending rewrites on the fly on every read path so reads look
in-sync without flushing. Spec:
`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`.

**The conclusion reached this session (the operator agreed the coalesced
model is right *for an agent host*, but the implementation needs
hardening):** Cubical is meant to host AI agents (sandboxed WASI/WASM
plugin ABI). That makes bulk renames/refactors common (so coalescing's
write-batching is genuinely valuable, and at L7 it batches CRDT/sync
ops), and the pending/materialize layer doubles as a **staging +
instant-undo** surface for "agent proposes → review → commit/rollback".
Because agents read through the host API (which materializes), the
"external tools see stale disk" objection mostly doesn't apply to them.
So **keep the coalesced + materialize model.** But agents make two
implementation weaknesses dangerous enough to be prerequisites:

1. **Durability of pending state (top priority).** Pending rewrites are
   *non-derivable critical state* but live in libSQL, which the
   architecture treats as disposable/rebuildable from `.md`. They are
   NOT rebuildable (the `.md` doesn't reflect them yet). A wipe/crash
   mid-burst silently half-reverts a rename — catastrophic for an
   unattended agent doing a 200-file refactor. Needs a real durable
   journal (or eager-async flush so there's nothing critical to lose).
2. **A single materialize choke point.** Today every read path must
   remember to call `materialize_on_read`; we already missed the open
   buffer this session. With concurrent agents reading, "one path
   forgot" feeds wrong data into a reasoning loop. Make it structurally
   impossible to read non-materialized — one gateway, not a convention.

Also consider: concurrency control for multiple agents on the shared
pending queue; a prompt-enough flush to bound how stale the
human-observable disk (vim/git) gets; and honestly amending the
non-negotiable from "plain `.md` is the absolute source of truth" to
"`.md` **+ a durable pending journal** are truth" (or eliminating the
pending state via eager-async flush). Obsidian, by contrast, rewrites
all referrers eagerly on disk at rename — simpler and disk-is-always-true,
but no staging/undo and heavy write amplification under agentic bulk
work; rejected as the default for this product.

**Scope note:** Thread B is L3/architecture, larger than a single layer
session and not blocking L4. Decide with the operator whether it runs
now (as its own architecture session) or is parked until after L4 / near
L7 (sync) when the durability + concurrency stakes peak. The Thread A
read-only fix holds the user-visible symptom in the meantime.

## After this

L4-C — `Cmd/Ctrl+K` Omni-Bar (next L4 session). Also slated for an L4-A
revisit: generalise backend fuzzy to span fields (currently title-only),
now worked around by `fuzzy:false`.
