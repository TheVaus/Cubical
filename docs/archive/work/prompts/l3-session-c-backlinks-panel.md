> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session C — Backlinks panel + right-sidebar shell

L3 Session C for the Cubical project. The collapsible right-sidebar
shell lands (per `ui.md` §11.1) with the Backlinks panel as its first
occupant; for the open note, every note whose `links.target_path`
resolves to it appears with a context snippet; a row click navigates;
the panel refreshes live as the index changes. Builds on the Session A
`links` table and the Session B navigation flow. Do NOT start any
further L3 work in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state" block.
   - `docs/README.md` — docs index.
   - `docs/layer-3-spec.md` — especially §1 goal 3, §2.3 (Backlinks
     panel + right sidebar), §3.1 (`get_backlinks`), §3.5
     (`vault:index-changed`), §4 (frontend file map: `RightSidebar.tsx`
     + `sidebar/Backlinks.tsx`), §5 deviations, §8 Session C, and §9.1
     + §9.2 (what Sessions A and B landed).
   - `docs/architecture/ui.md` §11.1 (right sidebar in the locked
     layout) and §11.4 (CSS-variable token surface — every new UI
     component consumes tokens, no hardcoded values).
   - `docs/conventions.md` — code style.

2. Read for context (skim, you'll come back to specific lines):
   - `crates/cubical-index/src/links.rs` — the `links_to` query landed
     in Session A. Note that the existing SELECT does **not** project
     `source_path` (it returns the same `LinkRow` shape as
     `links_from`); the backlinks UI needs `source_path`, so Session C
     must extend the query module — either a new shape (e.g.
     `BacklinkRow { source_path, position, ... }`) or an enriched
     `links_to` that returns `(LinkRow, source_path)` tuples.
   - `crates/cubical-app/src/commands/links.rs` — the Session A
     `resolve_link` handler; mirror its shape for `get_backlinks`.
   - `crates/cubical-app/src/events.rs` — emit helpers + the existing
     `vault:file-changed` event. `vault:index-changed` is in the spec
     (§3.5) but not yet implemented; see the "Live refresh strategy"
     decision below.
   - `ui/src/App.tsx` — the existing layout (file-list left,
     editor centre, no right sidebar yet). The Session B navigation
     flow (`handleNavigateWikilink` → `handleSelectFile`) is the seam
     a row click reuses.
   - `ui/src/api/ipc.ts` — wrap `get_backlinks` here.
   - `ui/src/styles/tokens.css` (or its current location) — every new
     UI surface consumes design tokens (no hardcoded colors / radii /
     spacings); see `ui.md` §11.4.

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` →
     `Merge L3 Session B — wiki-link Live Preview + click-to-navigate`
     (commit `fce3341`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`,
     `l1`, `l2`; does NOT contain `l3`.
   - CLAUDE.md "Project state" reports L3 Sessions A + B done,
     Sessions C–K pending. If not, STOP.

4. Baseline test counts (must match CLAUDE.md "Project state"):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace` →
     170 Rust tests green.
   - `cd ui && npx vitest run` → 161 vitest green.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-c-backlinks-panel`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `writing-plans` — produces a fresh `docs/superpowers/plans/<date>-l3-session-c-backlinks-panel.md`
  from the L3 spec §2.3 + §8 Session C. Same shape as Sessions A and B
  (`docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`,
  `docs/superpowers/plans/2026-05-25-l3-session-b-wikilink-live-preview.md`).
- `executing-plans` (or `subagent-driven-development` if subagents are
  available) — works through the plan task-by-task with checkpoints.
- `test-driven-development` — every behaviour change lands with a
  failing test first, mirroring Sessions A and B. Rust query +
  command tests live next to the existing modules; the panel logic
  unit-tests as a pure-data shape (a "group backlinks by source file"
  helper, say) plus a small integration test with a stub IPC.
- `verification-before-completion` — at the end, fresh test output and
  a recorded manual smoke pass against `cargo tauri dev` before any
  merge.
- `finishing-a-development-branch` — ALWAYS, at the very end.

SKIP `brainstorming` — Session C's scope is fully specified in
`docs/layer-3-spec.md` §2.3 + §8 Session C. If a sub-decision arises
that the spec doesn't pin down (see "Decisions to raise in the plan"
below), record it as an explicit decision in the plan rather than
expanding scope.

---

## STEP 2 — THE WORK (layer-3-spec.md §2.3 + §8 Session C)

In summary (full task breakdown lives in the plan written at STEP 1):

1. **`get_backlinks` IPC.** Pure handler in
   `crates/cubical-app/src/commands/`, Tauri shim in `lib.rs`, TS
   wrapper in `ui/src/api/ipc.ts`. Request `{ vault_id, path }`,
   response `{ backlinks: [{ source_path, context, position }] }` per
   spec §3.1. The handler reads `links` rows where
   `target_path == path`, loads the source file's text, and produces a
   short context snippet (a one-or-two-line window around `position`).
   Mirror the L0 §8 pure-handler + thin-shim pattern.

2. **`links_to` query enrichment.** Extend `crates/cubical-index/src/links.rs`
   so the backlinks query surfaces `source_path` (the existing
   `links_to` returns a `LinkRow` shape that omits it). Either:
   - Add a new `backlinks_for(target_path)` returning a dedicated
     `BacklinkRow { source_path, position, ... }`, or
   - Enrich `links_to` to return `(source_path, LinkRow)` tuples.
   Resolve in the plan — the first is cleaner if `links_to` has other
   callers; the second avoids duplication. Add at least one query test
   covering multiple sources pointing at one target with stable
   per-source ordering (Session A already orders by
   `(source_path, position)`).

3. **Context snippet.** A small pure helper takes the source file's
   text and the link's `position` (the block-span offset Session A
   stores) and returns a snippet — concretely, a window of N
   characters (default ~120) around the position, single-line
   (collapsing newlines to spaces), trimmed on word boundaries when
   possible. The exact heuristic is a plan decision; the only hard
   contract is that the snippet is non-empty when the link's enclosing
   line has any text. Unit-test the helper directly.

4. **Right-sidebar shell.** New file `ui/src/RightSidebar.tsx` —
   collapsible, per `ui.md` §11.1. Session C ships exactly one panel
   (Backlinks); Session I will add Unlinked Mentions and a tab/segment
   selector. Keep the shell panel-agnostic so adding the second pane
   is purely additive. Collapsed state is the user's transient
   preference for the open vault; persist it as a setting
   (`ui.right_sidebar_collapsed`, boolean, vault-local — extend the
   `Setting` discriminated union in `ui/src/api/ipc.ts` accordingly,
   mirroring `editor.raw_source_default`).

5. **Backlinks panel.** New file `ui/src/sidebar/Backlinks.tsx`. For
   the open note, list each backlink as `{ source_path, context }`
   where the source path is the row label and the context snippet sits
   below it (one-row-per-link is the simplest model; an optional
   "group by source file" pass is fine, leave the decision to the
   plan). Empty state when the response carries zero backlinks. A row
   click reuses the Session B navigation seam — call into the parent's
   existing file-open flow with `{ path: source_path }` so autosave /
   `seenHash` / `dirty` plumbing stays correct.

6. **Live refresh.** The panel refreshes whenever the link index
   changes for a file that could affect the current note's backlinks.
   Choose one (plan decision):
   - **(a) Piggyback on `vault:file-changed`.** Cheapest. Any vault
     file change → re-fetch `get_backlinks` for the open note. Already
     wired for the Session B resolver cache; the same listener can
     trigger the panel re-fetch (debounce ~200ms is sensible).
   - **(b) Ship the spec's `vault:index-changed`.** Per §3.5; emit
     from the Rust write-path after `replace_links_for_file` lands.
     Cleaner semantics, more code.
   Recommended: (a) for Session C — the spec doesn't require (b) until
   the unlinked-mentions / tag-pages surfaces also need it. Promote
   (b) when a second consumer appears.

7. **App.tsx wiring.** Render `<RightSidebar>` in the main layout
   (right side of the flex row that currently holds the file list +
   editor). Pass `vaultId` and `selectedPath` so the panel can fetch
   on file-selection change. Wire row clicks to the existing
   navigation flow.

8. **Tests.**
   - Rust: query test for `links_to` enrichment (backlinks shape +
     ordering); pure handler test for `get_backlinks` covering empty,
     single source, multiple sources; pure snippet helper test
     covering position-near-start / position-near-end / multi-line
     blocks.
   - TS: panel rendering against a stub IPC — empty state, one row,
     several rows with row-click handler invoked with the expected
     path. Settings round-trip for the collapsed state.

9. **Spec write-up.** Fill `docs/layer-3-spec.md` §9.3 (the
   "Session C — Backlinks panel + right-sidebar shell" subsection)
   with what landed, mirroring §9.1 + §9.2 voice + structure
   (including a "Decisions worth noting" block).

10. **Project state.** Rewrite (do not append) the CLAUDE.md "Project
    state" block: layer 3, Sessions A + B + C done, Sessions D–K
    pending; final test counts; "Next" set to Session D — Tags
    (parsing, index, nested tags, decoration).

---

## Decisions to raise in the plan (the spec leaves them open)

- **`links_to` shape vs. new `backlinks_for`.** See item 2 above.
- **Context-snippet heuristic.** Width, line-collapsing, word-boundary
  trimming. Spec just says "context snippet around the link".
- **One row per link vs. group-by-source.** Spec says
  "each row showing the source note and a context snippet around the
  link" — singular row, so per-link is faithful. Grouping is an
  optional polish; record the decision either way.
- **Live-refresh route: (a) piggyback vs. (b) ship `vault:index-changed`.**
  See item 6 above.
- **Collapsed-state persistence.** Vault-local setting or
  process-local memory? Vault-local feels right (matches
  `editor.raw_source_default` / `appearance.theme_mode`); confirm in
  the plan.
- **Sidebar width.** Pick a value that matches the file-list pane's
  `18rem` so the layout feels balanced; expose as a token if a future
  resizer surfaces.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` →
  170 baseline + N new (document the new count: query + handler + snippet helper).
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 161 baseline + N new; record the new count.
- `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo fmt --check` → clean (per `docs/conventions.md`).
- **Interactive smoke** against `cargo tauri dev` — a small test vault
  with three or four notes that reference each other, plus one note
  with zero backlinks. Record evidence: that selecting the linked-to
  note populates the panel; that the snippet is meaningful; that a
  row click opens the referencing note (and that the editor's
  autosave / `seenHash` stayed correct after navigation); that
  creating a new link in another file (or deleting one) updates the
  panel without a reload; that the empty state renders for the
  zero-backlinks note; that the sidebar collapses and the choice
  persists across vault re-open. The native Tauri window can't be
  browser-driven — this is hands-on. If a surface can't be verified,
  say so explicitly.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch
  `l3-session-c-backlinks-panel` created from `main`.
- [ ] Plan written at `docs/superpowers/plans/<date>-l3-session-c-backlinks-panel.md`.
- [ ] `get_backlinks` IPC end-to-end (pure handler + Tauri shim + TS
  wrapper); `links_to` (or new query) surfaces `source_path`.
- [ ] Snippet helper produces non-empty, single-line, sensibly-trimmed
  output for every link whose enclosing block has text.
- [ ] `RightSidebar` shell renders, collapses, persists the collapsed
  state to a vault-local setting.
- [ ] `Backlinks` panel lists every backlink with a context snippet;
  empty state when there are none; row click navigates via the
  existing file-open flow.
- [ ] Live refresh — adding / removing a link updates the panel
  without a reload (route decision recorded in the plan).
- [ ] §9.3 filled with what was built (Session A + B voice).
- [ ] CLAUDE.md "Project state" rewritten to Sessions A + B + C done.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`,
  `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded (or explicitly documented as deferred
  with the recommended smoke vault, per Session B's pattern).

---

## OUT OF SCOPE (do not build in this session)

- Tags, virtual tag pages, autocomplete (Sessions D–F).
- Block references, embeds proper, unlinked mentions (Sessions G–I).
  Note: the right-sidebar shell must leave room for the Unlinked
  Mentions panel that lands in Session I, but no Session I code is
  written here.
- Pending Rewrites Cache (Session J).
- The "graph view" or any visualisation surface — L9.
- Cross-vault backlinks — `ui.md` §11.5 declares them out of scope
  project-wide.
- A second-consumer use of `vault:index-changed` (tags / unlinked
  mentions). Even if Session C ships the event for completeness,
  no other panel subscribes to it this session.
- The L3 closeout tag (`l3`) — that's Session K.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits (matching Sessions A
   and B — `feat(index): …`, `feat(ipc): …`, `feat(app): …`,
   `test(...): …`, `docs: L3 Session C complete — …`). Do NOT skip
   hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project
   workflow: merge `l3-session-c-backlinks-panel` into `main` after
   verifying green, `--no-ff`.
3. Report back: every DoD box's status, any decisions deferred to the
   plan, the new test counts, the smoke evidence, and name the next
   session — L3 Session D (Tags: parsing, index, nested tags,
   decoration).
