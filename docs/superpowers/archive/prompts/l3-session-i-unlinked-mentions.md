# L3 Session I — Unlinked mentions

L3 Session I for the Cubical project. A second right-sidebar panel
("Unlinked Mentions") lands beside Backlinks (per `ui.md` §11.1): for
the open note, every plain-text occurrence of the note's title or any
frontmatter `aliases` value that is NOT already a link surfaces with a
context snippet, and a per-row "link it" action rewrites the matched
text into `[[…]]` on disk. The scan is the single most perf-sensitive
L3 surface — it must stay responsive on a large vault. Builds on
Sessions A (`links` index), C (`get_backlinks` + right-sidebar shell),
and the Session D `frontmatter` ingestion (aliases). Do NOT start any
further L3 work in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state"
     block (currently reports Sessions A–F + scan perf fix + G + `[[#^`
     + H.1 + H.2 done; I–K pending).
   - `docs/README.md` — docs index.
   - `docs/layer-3-spec.md` — especially §1 goal 4, §2.9 (Unlinked
     mentions), §3.1 (`get_unlinked_mentions`), §3.5 (events), §4
     (frontend file map: `sidebar/UnlinkedMentions.tsx`), §5
     deviations, §6 (Definition of Done), §8 Session I, plus the
     "Decisions worth noting" blocks in §9.3 (Backlinks panel — the
     pattern this panel mirrors) and §9.4 (Tags / `frontmatter` index
     — where `aliases` are stored).
   - `docs/architecture/ui.md` §11.1 (right sidebar — "backlinks pane
     **and unlinked mentions pane**" — Session I makes that "and"
     real) and §11.4 (CSS-variable token surface).
   - `docs/architecture/document-model.md` §5.5 (sanctioned-deviation
     pattern — relevant if the match-grammar needs editor-side awareness).
   - `docs/conventions.md` — code style.

2. Read for context (skim, you'll come back to specific lines):
   - `crates/cubical-core/src/vault/links.rs` — `extract_links` walks
     the canonical AST to find `[[…]]` / `[…](…)` occurrences. The
     unlinked-mentions scan is its complement: walk *text* runs that
     are NOT inside any link/embed token.
   - `crates/cubical-core/src/vault/scan.rs` — the existing two-pass
     scan (Pass 1: `refresh_links` + `refresh_blocks` + `refresh_tags`
     + `refresh_frontmatter`; Pass 2: `refresh_block_refs_for_file`).
     Session I's scan is **on-demand** (per-call IPC), not part of the
     vault scan. Don't add a new vault-scan pass.
   - `crates/cubical-core/src/vault/blocks.rs` + `vault/tags.rs` — the
     freshest "scan body text, fence-aware, skip code spans / fenced
     code / frontmatter" precedents. Mirror their fence-walk shape.
   - `crates/cubical-index/src/frontmatter.rs` — `aliases` storage
     (Session D §9.4 documented the shape). The IPC will need to read
     the OPEN note's aliases plus its title before the scan begins.
   - `crates/cubical-app/src/commands/backlinks.rs` — `get_backlinks`
     handler is the closest sibling: pure-handler + thin-shim, snippet
     builder, ordering by `(source_path, position)`. Mirror its
     structure for `get_unlinked_mentions`.
   - `crates/cubical-app/src/commands/vault.rs` — `write_file_text`'s
     `expected_seen_hash` gate. The "link it" rewrite needs the same
     conflict-safe write path.
   - `crates/cubical-app/src/lib.rs` — Tauri shim + `generate_handler!`
     registration. The recent `get_embed` (§9.12) is the freshest
     precedent.
   - `crates/cubical-app/src/api/types.rs` — wire-type style; the
     recent `GetEmbedRequest/Response` and
     `GetBrokenBlockRefsRequest/Response` are the freshest precedents.
   - `ui/src/RightSidebar.tsx` — Session C shell. The header comment
     explicitly says "Session I will add Unlinked Mentions and a
     tab/segment selector. The shell itself only handles the
     collapsed/expanded frame and the toggle button; the contents are
     `children`." Session I adds the selector (location TBD in the
     plan — inside `RightSidebar` or one level up).
   - `ui/src/sidebar/Backlinks.tsx` + `backlinks.test.ts` +
     `backlinksState.ts` — the panel + tests + signal pattern this
     panel mirrors verbatim.
   - `ui/src/App.tsx` — `selectedPath()` + the `vault:file-changed`
     listener (the panel re-fetches on debounced file-changed, per
     Session C's chosen route).
   - `ui/src/api/ipc.ts` — IPC binding style; recent `getEmbed` is the
     freshest precedent.
   - `ui/src/ast/wikilink.ts` — `scanWikilinks` tokenizer (the same
     grammar the unlinked-mentions scan must respect when deciding
     which spans are already-linked).

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` →
     `merge: L3 Session H.2 — embed widget` (commit `56e612b`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`,
     `l1`, `l2`; does NOT contain `l3`.
   - CLAUDE.md "Project state" reports L3 Sessions A–F + G + H.1 +
     H.2 done; Sessions I–K pending. If not, STOP.

4. Baseline test counts (must match CLAUDE.md "Project state"):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace` →
     289 Rust tests green.
   - `cd ui && npx vitest run` → 321 vitest green.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-i-unlinked-mentions`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `writing-plans` — produces a fresh
  `docs/superpowers/plans/<date>-l3-session-i-unlinked-mentions.md`
  from §2.9 + §8 Session I + the open decisions below. Same shape as
  recent plans
  (`docs/superpowers/plans/2026-05-25-l3-session-c-backlinks-panel.md`,
  `docs/superpowers/plans/2026-05-30-l3-session-h2-embed-widget.md`).
- `subagent-driven-development` (preferred — multiple independent
  tasks: scanner, IPC, panel, rewrite action, refresh wiring) or
  `executing-plans` if subagents aren't available.
- `test-driven-development` — every behaviour change lands with a
  failing test first. Rust: scanner + handler + rewrite-on-disk;
  TS: panel render + state signal + segment selector.
- `verification-before-completion` — at the end, fresh test output and
  recorded smoke evidence before any merge.
- `finishing-a-development-branch` — ALWAYS, at the very end.

SKIP `brainstorming` — Session I's scope is fully specified by §2.9 +
§8 Session I. Sub-decisions live in the "Decisions to raise in the
plan" block below; record them in the plan rather than expanding scope.

---

## STEP 2 — THE WORK (layer-3-spec.md §2.9 + §8 Session I)

In summary (full task breakdown lives in the plan written at STEP 1):

1. **Pure scanner — `cubical-core::vault::mentions`.** New sibling
   module to `vault::blocks` / `vault::tags`. Two pure functions:
   - `extract_text_runs(source: &str) -> Vec<TextRun>` (or a
     callback-shaped walker) — yields `(start_byte, slice)` for every
     text region that is **outside** all of: frontmatter, fenced/inline
     code, ATX/Setext heading marker chars, wiki-links `[[…]]` /
     `![[…]]`, markdown links `[…](…)` (display + url) and their
     reference forms, raw URLs auto-linked by Lezer. Reuse the
     fence-walk pattern from `vault::blocks::extract_block_ids` and
     the `scanWikilinks`-equivalent for `[[…]]` matching (pull the
     Rust-side `cubical_ast::wikilink::scan_wikilinks` into scope; no
     new tokenizer).
   - `find_mention_occurrences(source: &str, needles: &[&str]) ->
     Vec<MentionHit>` — for each needle, find every whole-word,
     case-insensitive occurrence inside the text runs from above.
     Whole-word = boundary before/after is `!alphanumeric() && !=
     '_'` (mirror Tantivy's default tokenizer boundary so future L4
     search agrees). Empty needles, needles containing whitespace,
     needles that are pure punctuation: skip silently. Returns
     byte-offset hits — `MentionHit { needle_index: usize, byte_offset:
     u64, byte_len: u64 }`.

   Heavy unit-test coverage. The hard cases — frontmatter skip,
   fenced/inline code skip, mention sitting *inside* a wiki-link
   display string, mention overlapping a markdown link's display vs.
   url, mention inside a callout / blockquote line (text — still
   matches), case-insensitivity, whole-word boundaries against
   hyphens / underscores / unicode whitespace.

2. **IPC handler — `cubical-app::commands::mentions::get_unlinked_mentions`.**
   Pure handler + Tauri shim + registration. Request `{ vault_id,
   path }`, response per §3.1: `{ mentions: [{ source_path, context,
   position }] }`. Handler steps (mirror `get_backlinks` shape):

   a. Snapshot `files.path` (the same shape `block_id_autocomplete`
      and `get_embed` use) — every `.md` file in the vault is a
      candidate source.
   b. Load the **open note**'s title + aliases:
      - Title = file basename minus `.md`. (Confirm in the plan;
        the spec says "the note's title". The codebase has no
        explicit "title" field elsewhere.)
      - Aliases = `frontmatter_aliases_for(path)` against the
        L3 §9.4 frontmatter index. Skip blank entries; deduplicate
        case-insensitively against the title.
   c. For each candidate source file (excluding the open note
      itself):
      - Read the file off the tokio runtime (mirror
        `vault::links::read_source_off_executor` — already widened to
        `pub` for H.1).
      - Call the pure scanner with `needles = [title, ...aliases]`.
      - For each `MentionHit`, build a snippet using the same helper
        the Backlinks panel uses (or its sibling — pluck out into
        a shared `vault::context_snippet` helper if `get_backlinks`'s
        is currently inline).
      - Emit `Mention { source_path, context, position, needle }`.
        Spec response omits `needle`; add it internally and drop on
        the wire (or expose for UI grouping — plan decision; see
        below).
   d. Stable order: `(source_path, position)` ascending. The frontend
      can choose to group by source.
   e. Budget guard: scan all files; do NOT short-circuit. The DoD
      requires the scan stays responsive on a large vault. The
      practical lever is the *per-file* cost — keep the scanner
      allocation-light. Document in the plan the expected budget on
      a 30k-file vault (educated estimate from the Session E perf
      fix is the latest precedent for "what counts as fast enough").

   Handler test matrix: empty vault, single source-no-mention,
   single source one mention, multiple sources, alias match,
   already-linked occurrence excluded, code-block occurrence
   excluded, open note's own mentions of itself excluded, missing
   frontmatter, frontmatter aliases of wrong shape (silently
   dropped).

3. **Rewrite action — `cubical-app::commands::mentions::link_mention`.**
   New handler. Request `{ vault_id, source_path, position,
   byte_len, target_title, expected_seen_hash }`. Response
   `{ new_hash }`. Behaviour: read source file → verify the byte
   range still spells the expected needle (case-insensitive) — if
   not, fail with `CubicalError::InvalidRequest` ("mention has
   moved"; the frontend will re-fetch and retry); splice
   `[[target_title]]` over the range; write atomically via
   `cubical_core::vault::atomic::atomic_write` with the
   `expected_seen_hash` guard (mirror `write_file_text`'s flow);
   return the new content hash so the editor's seen-hash plumbing
   stays correct when the user has that file open.

   Subtleties to settle in the plan:
   - **`target_title` form.** Just the title — e.g. `[[Daily]]` — or
     a display-text variant when the matched casing differs (e.g.
     match was `daily`, title is `Daily` → produce
     `[[Daily|daily]]`)? Default-pick: bare `[[Daily]]`; spec
     doesn't require preserving the original casing.
   - **Alias-matched rewrite.** When the match is an alias rather
     than the title, the produced link uses the file's title
     (because `[[alias]]` would have to resolve via Session A's
     resolver order, which works only if the alias is unique — it
     usually isn't). Plan should pick: always title (safe), or
     `[[Title|alias]]` to preserve the surface text (UX nice but
     adds a decision dimension). Recommend `[[Title|alias]]` only
     when alias ≠ title case-insensitively; bare otherwise.
   - **Concurrent edit conflict.** The frontend may not have a
     `seen_hash` for the source file (it's not the open note). Spec
     §5.7 (rename + pending rewrites) and §2.7 (external-edit
     conflict) name the patterns. For this command, plan-pick: use
     the file's current on-disk hash as the `expected_seen_hash`
     read just-in-time on the backend (read → splice → write with
     the same hash gate) so a same-millisecond external edit raises
     a conflict cleanly. Same shape as the Session J flush will
     need.

   Handler tests: rewrite single occurrence; conflict when content
   moved; conflict when seen-hash mismatched; idempotency after
   external write that already linked it (the byte range no longer
   spells the needle → InvalidRequest, frontend re-fetches —
   that's the spec's correct behaviour).

4. **Backend wiring.** Register both Tauri shims in `lib.rs`. No new
   migration. No new index table (the spec is explicit that the scan
   is on-demand). No new event — reuse `vault:file-changed` for the
   live-refresh route (decision below).

5. **IPC bindings — `ui/src/api/ipc.ts`.** Add `getUnlinkedMentions`
   + `linkMention` with `GetUnlinkedMentionsRequest/Response`,
   `LinkMentionRequest/Response`, and the `Mention` type. Mirror the
   `getEmbed` / `getBacklinks` binding shape.

6. **State signal — `ui/src/sidebar/unlinkedMentionsState.ts`.**
   Mirrors `backlinksState.ts`. Owns the in-flight fetch promise +
   debounce window. Exposes `mentions()` (Solid signal of
   `Mention[]`) and `refresh(vault_id, path)`. Tests against a stub
   IPC: empty, single source, multiple, fetch dedup, race-cancel.

7. **Panel — `ui/src/sidebar/UnlinkedMentions.tsx`.** One row per
   mention (or grouped by source file — plan decision; consistent
   with whatever Backlinks ships). Each row: source path, context
   snippet, and a "link it" button. Click "link it" → call
   `linkMention` IPC → on success, the row disappears (refresh
   re-runs because `vault:file-changed` will fire after the write).
   Empty state when zero mentions. Tests mirror `backlinks.test.ts`.

8. **Right-sidebar segment selector.** The shell currently takes a
   single `children`. Add a tabbed/segmented view above the contents.
   Plan-pick: segmented control ("Backlinks | Unlinked Mentions") with
   the selected segment lifted to `App.tsx` and persisted as a
   vault-local setting (`ui.right_sidebar_panel`, enum
   `"backlinks" | "unlinked_mentions"`; extend the `Setting`
   discriminated union). Default: `"backlinks"` (no behaviour change
   for existing vaults).

9. **App.tsx wiring.** Render the selected panel inside
   `<RightSidebar>`. Wire `vault:file-changed` debounced refresh
   (mirror the backlinks refresh — `BACKLINKS_REFRESH_DEBOUNCE_MS`
   already exists; reuse the same constant or rename to
   `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS`). Reset state on vault open
   and close, mirroring backlinks lifecycle.

10. **Spec write-up.** Fill `docs/layer-3-spec.md` §9.14 ("Session I —
    Unlinked mentions") with what landed, mirroring §9.3 (Backlinks)
    voice + structure (Wire shape · Pure scanner · Handler · Rewrite ·
    Panel · Decisions worth noting · Tests · Smoke status · What's
    left for L3).

11. **Project state.** Rewrite (do not append) the CLAUDE.md "Project
    state" block: layer 3, Sessions A–F + G + H.1 + H.2 + I done;
    Sessions J + K pending; final test counts; "Next" set to Session J
    (Rename → Pending Rewrites Cache).

---

## Decisions to raise in the plan (the spec leaves them open)

- **Title source.** Filename basename minus `.md`. Spec says "title";
  no `title:` frontmatter convention exists in the codebase. Confirm
  the rule + the case behaviour.
- **Whole-word boundary grammar.** `!alphanumeric() && !='_'` on
  both sides — recommended. Note unicode handling: use Rust's
  `char::is_alphanumeric` (locale-independent) rather than ASCII-only.
- **Alias-matched rewrite shape.** `[[Title|alias]]` when alias ≠
  title case-insensitively; bare `[[Title]]` otherwise. Plan to
  confirm.
- **Match casing in the rewrite.** Drop the source casing (use the
  canonical title/alias) or preserve via display text. Recommend:
  drop, except when alias-matched (see above).
- **Source-file `expected_seen_hash`.** Read just-in-time on the
  backend (the rewrite command computes the current hash as part of
  read → splice → write). Frontend supplies `null` for source
  files that are not the open note. The handler still uses the
  atomic-write guard against same-millisecond external edits.
- **Live-refresh route.** Piggyback on the same debounced
  `vault:file-changed` listener Backlinks already uses. No new
  event.
- **Segment selector location.** Inside `RightSidebar` (the shell
  owns the tab UI) vs. `App.tsx` (the parent renders a chrome bar
  above the shell). Lean toward the shell — keeps `App.tsx` flatter.
- **Group by source file vs. flat list.** Whatever Backlinks
  currently ships; confirm in the plan and keep both panels
  consistent.
- **Panel ordering when both have entries.** Out of scope — only one
  panel renders at a time via the segment selector. (If a future
  session unifies them into a "Mentions" pane, that's a separate
  decision.)
- **Snippet helper sharing.** If Backlinks' snippet builder is
  currently inline in its handler, lift it to
  `cubical_core::vault::context_snippet` (or a `commands::shared`
  helper) so both panels produce identical-looking context. If it's
  already shared, reuse as-is.
- **Open note exclusion.** A note never appears in its own
  Unlinked Mentions list (its own mentions of itself are not
  surfaced). Confirm.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` →
  289 baseline + N new (scanner + handler + rewrite + snippet helper if
  lifted). Document the new count.
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 321 baseline + N new (state signal +
  panel + segment selector). Document the new count.
- `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo fmt --all --check` → clean.
- **Interactive smoke** against `cargo tauri dev` (hands-on — the
  native Tauri window can't be browser-driven). Smoke vault:
  ```
  Daily.md (frontmatter: aliases: [diary, journal]):
    body — see Project for context.
  Project.md:
    Worked on the daily today. The Journal entry tracks this.
    Also see [[Daily]] — this occurrence must NOT appear.
    `daily` inside code — this occurrence must NOT appear.
  Notes.md:
    Mentions of the journal and Daily across multiple lines.
  ```
  Verify:
  - With `Daily.md` open, the panel lists exactly the qualifying
    occurrences in `Project.md` (3 expected: "daily" body match,
    "Journal" alias match, "Daily" mention) and the matches in
    `Notes.md`. The already-linked `[[Daily]]` in `Project.md` does
    NOT appear. The code-spanned `\`daily\`` does NOT appear. The
    open note's own body is excluded.
  - Clicking "link it" rewrites the matched span to `[[Daily]]` (or
    `[[Daily|alias]]` per the plan decision) on disk; the row
    disappears; the editor (if the rewritten file was open in
    another vault session or via tab — note: no tabs yet) refreshes
    cleanly without conflict.
  - Switching the right-sidebar segment to Backlinks still works
    (no regression).
  - The collapsed-sidebar state from Session C still works.
  - On a 5–10k-file vault if available, scan completes "responsively"
    (sub-second on a warm cache; sub-2-second cold). If only the
    small smoke vault is available, record that.
  If a surface can't be verified hands-on, say so explicitly and
  record the recommended smoke vault — same protocol as Sessions B,
  G, H.2.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch
  `l3-session-i-unlinked-mentions` created from `main`.
- [ ] Plan written at
  `docs/superpowers/plans/<date>-l3-session-i-unlinked-mentions.md`
  with every "Decisions to raise" item resolved.
- [ ] `cubical-core::vault::mentions` pure scanner (text-run walker +
  occurrence finder) ships with full unit coverage of the hard cases
  (frontmatter / fenced / inline-code skip, wiki-link skip, markdown
  link display vs. url, whole-word boundaries, case-insensitivity,
  alias dedup).
- [ ] `get_unlinked_mentions` IPC end-to-end (pure handler + Tauri
  shim + TS wrapper); response shape per spec §3.1; stable ordering;
  open-note self-exclusion.
- [ ] `link_mention` IPC end-to-end with conflict-safe rewrite (atomic
  write + on-disk hash gate); idempotent re-call after external link
  fails cleanly with `InvalidRequest`.
- [ ] `UnlinkedMentions` panel renders, empty state works, row "link
  it" rewrites and refreshes; segment selector switches Backlinks ↔
  Unlinked Mentions and persists to `ui.right_sidebar_panel`.
- [ ] Live refresh — adding / removing a link, or running "link it",
  updates the panel without a reload via the debounced
  `vault:file-changed` listener.
- [ ] §9.14 filled with what was built (§9.3 Backlinks voice +
  structure).
- [ ] CLAUDE.md "Project state" rewritten to Sessions A–F + G + H.1 +
  H.2 + I done; J + K pending; next = Session J.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`,
  `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded (or explicitly documented as deferred
  with the recommended smoke vault, per H.2's pattern).

---

## OUT OF SCOPE (do not build in this session)

- Rename / Pending Rewrites Cache (Session J).
- L3 closeout, `l3` tag, hands-on smoke pass of ALL L3 surfaces
  (Session K).
- H.3 polish — rich markdown rendering inside the embed body, click
  navigation inside embed widgets, `⎘`-indicator retirement.
- A new `vault:index-changed` event (Session C deferred this; only
  ship if a second consumer of the live-refresh signal materialises in
  this session — it doesn't).
- Pre-indexed mentions table (an obvious L4 perf upgrade if the
  on-demand scan turns out to be insufficient at scale; do NOT add a
  new index table in I).
- Pretext (`docs/architecture/foundation.md`) — variable-height row
  virtualization. The unlinked-mentions panel renders one row per
  occurrence; if the list is long, the existing fixed-height-row
  pattern from the file list (`ui/src/virtualList.ts`) is the
  fallback. A Pretext-integration session is unscheduled and not
  in I.
- Fuzzy / stemmed matching, plurals, possessives. Spec says
  occurrences of the title / aliases — literal whole-word only.
- Cross-vault mentions — `ui.md` §11.5 declares cross-vault out of
  scope project-wide.
- Editor decorations for unlinked mentions (e.g. underline in the
  editor). The spec is panel-only; editor decoration would belong
  in a separate session and is out of scope.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent
   sessions (`feat(core): …`, `feat(index): …`, `feat(app): …`,
   `feat(ui): …`, `test(…): …`, `docs(l3): close Session I — …`). Do
   NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project
   workflow: merge `l3-session-i-unlinked-mentions` into `main` after
   verifying green, `--no-ff`, with a `merge: L3 Session I — unlinked
   mentions` commit message mirroring the H.1 / H.2 merge style.
3. Report back: every DoD box's status, any decisions deferred to the
   plan, the new test counts, the smoke evidence, and name the next
   session — L3 Session J (Rename → Pending Rewrites Cache).
