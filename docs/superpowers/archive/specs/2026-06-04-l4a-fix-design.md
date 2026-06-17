# L4-A-fix — Editor surface contracts (design)

> **Status:** design. Brainstormed 2026-06-04, kickoff
> `docs/superpowers/2026-06-03-l4a-fix-kickoff.md`. Implementation plan
> follows in `docs/superpowers/plans/` (writing-plans step).
>
> **This is not L4-B.** L4-B is gated on this session closing with
> executed smoke + `l4a-fix` tag.

## 1. What this session is

A structural-debt session sitting between L4-A close (`l4a` tag,
2026-06-03) and L4-B open. Not a feature surface — three editor-state
contracts that surfaced as missing when interactive smoke against
`~/Developer/sandbox/cubical-l4a-smoke/` exposed three reproducible
bugs the L3 closing sessions never ran smoke against.

The kickoff named six bugs. Re-verification against the live smoke
vault during the brainstorm reduced that to three:

| Bug | Status | Disposition |
|-----|--------|-------------|
| #1 `^block-id` muted+small in Live Preview | Current rendering is intended. | Dropped from session. Kickoff record updated. |
| #2 `[[Aliased Note#Heading section]]` self-anchor scroll | Works against live vault. | Dropped from session. |
| #3 self-ref via path silent no-op | No-op is correct behavior (nowhere to scroll to). | Dropped from session. |
| #4 raw-source mode keeps embed widget over raw text | **Confirmed broken.** | In scope — Contract 1. |
| #5 `A.md` / `B.md` / `C.md` embeds stuck on "Loading…" | **Confirmed broken.** | In scope — Contract 4 (instrument-then-fix). |
| #6 up-arrow with embed in doc jumps cursor to start | **Confirmed broken.** | In scope — Contract 2. |

The architectural cleanup originally proposed for navigation paths
(kickoff §C) is **deliberately deferred** — its motivating bugs
aren't reproducing, and L4-B (search panel) doesn't need it. Trigger
to revisit: L4-C (Omni-Bar) when same-file symbol jumps land in scope.

## 2. Non-negotiables held

All CLAUDE.md non-negotiables hold:

- Plain `.md` files remain the source of truth.
- No UUID injection.
- No relaxation of the WASI/WASM plugin sandbox.
- Vault portability untouched.
- Desktop-only v1 unchanged.
- No new Tauri command surface in this session — `get_embed`,
  `resolve_link`, and the search commands are unchanged.

The Rust crates (`cubical-core`, `cubical-ast`, `cubical-index`,
`cubical-search`, `cubical-sync`) are untouched. All changes are in
`ui/` and one short edit to `docs/conventions.md`.

## 3. Contracts

### 3.1 Contract 1 — Live-Preview bundle (closes #4)

**Problem (kickoff §A).** `decorationCompartment` correctly gates the
decoration plugin (raw-source toggle swaps it for `[]`). But
`embedExtension` was added to the base extension list outside the
compartment — so toggling to raw source reveals the underlying
markdown text while the embed block widget continues rendering on
top of it. There is no enforced contract that every "Live Preview
transformation" extension joins the gated compartment; each new
layer (and L4-B's editor-side search-hit highlighting will be the
next) has to remember to do so by convention.

**Contract.** A single named bundle is *the* Live-Preview surface:

```ts
// ui/src/editor/livePreview.ts (new)
export const livePreviewBundle: Extension = [
  livePreviewDecorations,   // existing — re-exported
  embedBlockField,          // moved out of base extension list
  embedBaseTheme,           // moved out of base extension list
];
```

`Editor.tsx` wires `decorationCompartment.of(rawSource ? [] :
livePreviewBundle)`. A doc comment on the bundle states the contract:
*every transformation that should disappear in raw-source mode goes
here; adding a preview-only extension elsewhere is a bug.*

**What this closes.** Bug #4: raw-source toggle now structurally kills
the embed StateField — the `![[…]]` source bytes are visible without
the widget rendered above. L4-B's search-hit highlight extension joins
the bundle; the contract enforces itself by inspection.

**What stays unchanged.** `decorations.ts` (including `findBlockIds`
and `mark-blockid` rendering — bug #1 dropped). `embed.ts`'s
StateField internals (Contract 2 changes them separately). The
`decorationCompartment` mechanism itself.

### 3.2 Contract 2 — Embed atomic-replace at byte span (closes #6)

**Problem (kickoff §B).** Today's embed widget is a block widget
attached at `line.to` with `side: 1`, `estimatedHeight: 60`, and no
`coordsAt` / `ignoreEvent` / `lineBreaks`. It claims vertical space
without giving CM6 the layout signals needed for cursor traversal,
selection, or click-to-position to behave. Bug #6 (up-arrow jumps to
doc start) is one symptom. Click-into-embed, selection-across-embed,
find-next-across-embed have the same root.

**Contract.** The `![[…]]` token's actual byte span renders as the
widget. The `WikiLink` Lezer node spans the full `![[…]]` (verified —
`ui/src/editor/wikilink.ts::parseWikiLink` includes the leading `!`
in `cx.elt("WikiLink", pos, tokenEnd)`). `buildDecorations` emits an
atomic **inline** replace over the token: `Decoration.replace({ widget
}).range(node.from, node.to)`.

> **CORRECTION (post-smoke, 2026-06-06).** This contract originally
> prescribed an atomic *block* replace (`Decoration.replace({ widget,
> block: true })`). Operator smoke proved that wrong: every embed in a
> real note is written mid-line (`embeds: ![[B]]`), so the token is a
> *sub-line* range, and a `block: true` replace over a sub-line range
> is a **malformed block decoration** — block decorations must cover
> whole lines. That malformed range is what produced the "cursor jumps
> to row 2" regression (bug #6, second sighting). An empirical jsdom
> probe confirmed: range `[13,19)` over line `[5,19)`, and the block
> variant threw `getClientRects` on mount. The landed fix is an atomic
> **inline** replace, which is valid over any sub-line range and which
> CM6 steps the cursor over cleanly. The original Task 2 test fixture
> (`![[Daily]]` alone on its own line, where node-range == line-range)
> masked the bug; fixtures now use the real mid-line shape.

`EmbedWidget` (renamed from `EmbedBlockWidget`):

- `ignoreEvent(_event) → false` — lets clicks bubble to the existing
  capture-phase mousedown handler.
- `coordsAt` and `estimatedHeight` overrides REMOVED — both were
  block-widget concepts (the `coordsAt` returned a bogus uniform
  full-frame rect for every position, which actively confused vertical
  cursor motion). CM6 measures the inline widget's DOM directly.
- Identity (`eq`) folds in the resolver's `version()` (see §3.3) so
  nested-embed resolutions force a remount.

**Cursor-line behavior.** Same pattern as `Emphasis`, `StrongEmphasis`,
`Link` already use: when the cursor is on the line containing the
`![[…]]` token, the source byte range reveals (no atomic replace
emitted); when off, the widget replaces it. The user's mental model is
preserved — "what I see is what's in the file" — and there is no place
the cursor can sit "between" the source token and its rendering. The
StateField gains a stored `activeLineNumber` and rebuilds when it
changes; intra-line cursor moves do not trigger rebuild.

**The `⎘` indicator retires.** Today `decorations.ts` emits a
zero-width `Decoration.widget` with a `⎘` glyph at the embed token's
start as a placeholder marker (Live Preview shows the token's presence
even when the rich rendering is deferred). Once the embed widget owns
the visual, the `⎘` is redundant. This naturally closes the deferred
"`⎘`-indicator retirement" polish item from
[layer-3-spec.md §"What's left for L3"](../../../layer-3-spec.md). The
`DecoKind` `"mark-wikilink-embed"`, the `EmbedIndicatorWidget` class,
`wikilinkEmbedDeco`, and the `.cm-md-wikilink-embed` CSS rule all
delete.

**What this closes.** Bug #6: CM6 treats an atomic inline replace as a
steppable unit with valid measurable geometry, so vertical cursor
motion computes the adjacent line correctly instead of landing on a
spurious row. (jsdom cannot verify pixel geometry; final confirmation
is the operator's interactive smoke — see §8 risk note.)

### 3.3 Contract 4 — Resolver introspection + abort (closes #5)

**Problem (kickoff §D).** `EmbedResolver` and `WikiLinkResolver` are
created per vault open. There is no way to inspect "what's the cache
state right now?", no way to cancel in-flight fetches at vault swap,
and no visible signal when a `then` / `catch` handler fails to fire.
Bug #5 (embeds stuck on "Loading…") cannot be root-caused without
instrumentation; the previous session's deadlock hypothesis was
ungrounded (`get_embed` doesn't touch `vault.search()`). The bug could
live in the IPC, the resolver's promise chain, the StateField's
`embedResolverUpdated` handling, the Tauri serialization of
`GetEmbedResponse`, or somewhere else entirely.

**Contract.** Both resolvers grow the same observability interface:

```ts
export interface ResolverDebugState {
  cacheSize: number;
  inFlight: string[];               // keys currently fetching
  lastFetchAt: Map<string, number>; // ms epoch of fetch start
  lastSettleAt: Map<string, number>;
  lastError: Map<string, string>;
}

export interface ResolverEvent {
  kind: "fetch-started" | "fetch-settled" | "fetch-errored" | "invalidate" | "abort";
  key?: string;
  error?: string;
  at: number;
}

// Composed onto the existing ObservableResolver shape:
debug(): ResolverDebugState;
onEvent(handler: (e: ResolverEvent) => void): () => void;
abort(): void;  // aborts in-flight fetches; cache untouched
```

In dev builds (`import.meta.env.DEV`), `Editor.tsx` exposes
`window.__cubical = { embedResolver, wikilinkResolver }` so the
operator can inspect live resolvers from the devtools console. In
production builds, `window.__cubical` is not set.

Symmetrical shape across both resolvers establishes the pattern for
L4-B / L4-C / L4-D and the L6 plugin layer's async caches — kickoff
§"Project-goal alignment" notes that L6 plugin sandboxing needs the
host to introspect and cancel its own async work.

**Bug #5 workflow.** Instrumentation lands first (commit 4a, no
behavior change). The operator smokes `A.md` / `B.md` / `C.md` against
the live resolver, reads `debug()` and the event log, and the
diagnostic evidence narrows the actual cause. Then a targeted fix
lands (commit 4b) with a regression test against *that* cause. The
fix is not pre-specified — kickoff is explicit: don't propose one
until evidence narrows it.

**Bug #5 diagnostic decision tree.** Run in the dev console with the
smoke vault open and `A.md` selected. Wait ~3 seconds after open.

```
Step 1 — inspect __cubical.embedResolver.debug():

  inFlight non-empty after 3s
    → fetch never settled. Confirm by checking lastSettleAt
      for the stuck key (should be absent if fetch hung).
    → Cause is in the promise chain, the IPC layer (Tauri
      serialization, command registration), or the Rust handler.
    → Next: subscribe onEvent and capture whether fetch-started
      fired without a matching fetch-settled or fetch-errored.

  inFlight empty AND lastError populated for stuck key
    → Fetch settled with an error. Cache holds UNRESOLVED.
    → Cause is the render branch in renderEmbedBody mis-handling
      UNRESOLVED, OR the StateField not rebuilding on the
      embedResolverUpdated effect.
    → Next: confirm the StateField's update fn ran (DecorationSet
      version differs between transactions).

  inFlight empty AND lastSettleAt populated AND lastError absent
    → Fetch settled successfully but UI still stuck on "Loading…".
    → Cache holds a resolved entry but the editor never rebuilt.
    → Cause is in the onUpdate subscription (Editor.tsx) or
      the embedResolverUpdated effect dispatch / handling.
    → Next: confirm the subscription is wired
      (subscribeEmbedResolver ran for this view) and that
      embedResolverUpdated effects landed (inspect transaction log).

Step 2 — subscribe onEvent for a clean cycle:

  const log = [];
  const unsub = __cubical.embedResolver.onEvent(e => log.push(e));
  __cubical.embedResolver.invalidate();   // clear, force refetch
  // wait ~3s, then:
  console.table(log);
  unsub();

  Expected sequence per target: fetch-started → fetch-settled
  (or fetch-errored). Missing entries identify the broken link.
```

The diagnostic step's observations are recorded in the executed
smoke runbook before commit 4b is drafted.

**Bug #5 diagnostic observation (recorded 2026-06-06).** The operator
smoke localized the cause WITHOUT needing the console tree above —
the failure was *structural*, visible from the embed chain alone:

- Smoke vault embeds form a chain `A→B→C→D→E`, depth-capped at 4 (E
  is the leaf). A/B/C froze on "Loading…"; **D worked**.
- D works because its embed (E) is **depth-1** — the top-level
  widget's cache entry *is* what changes when E resolves, so eq()
  flips and CM6 remounts. A/B/C embed content nested **≥2 deep**.
- An empirical jsdom probe confirmed: after a nested target resolves,
  the top-level widget's `eq()` returns `true` (no remount). Nested
  embeds are plain DOM built inside the parent's `toDOM()` with **no
  independent re-render path** — their only refresh is a parent
  remount, which is gated on the parent's *own* cache entry. That
  entry never changes when a descendant resolves, so the nested
  `Loading…` freezes forever.

**Cause layer: `ui/` (resolver + widget identity).** Inside the
session's stated scope — the §8 circuit-breaker does NOT fire; no
Rust / IPC change needed.

**Fix landed (commit `88bd614`).** `EmbedResolver` gains a
`version()` counter bumped on every cache mutation (settle / error /
invalidate). `EmbedWidget.eq()` folds `version` in, so ANY resolution
change — including a deep nested one — forces a remount and a full
recursive re-render, which picks up the resolved descendant and kicks
the next cold fetch down the chain until it converges (or hits the
depth cap). Version is stable across unrelated edits, so steady-state
keystrokes don't remount embeds. Regression test:
`ui/src/editor/embed.test.ts` ("bug #5: widget identity changes when
the resolver version bumps") + `ui/src/editor/embedResolver.test.ts`
("version() bumps on every cache mutation").

**What this closes.** Bug #5. The lasting observability + abort
interface remains as the pattern future async caches inherit.

### 3.4 Contract E — Smoke ritual in `docs/conventions.md`

**Problem (kickoff §E).** L1, L2, L3, and L4-A all closed with smoke
recipes *recorded* but not *executed*. The closeout DoD says
"smoke recipes recorded" — it should say "smoke recipes executed."
This session is the user hitting four sessions' worth of unverified UI
in one batch.

**Change.** New section in `docs/conventions.md` after `## Commits`:

```markdown
## Sessions

- Every session that touches user-facing surface area has an
  interactive `cargo tauri dev` smoke pass *executed* against a real
  vault before the layer or fix tag lands.
- Recorded recipes alone do not satisfy session close. The smoke
  is performed by a human operator; the executed runbook is committed
  alongside the spec with the operator's identifier and the build
  commit.
- A session that cannot run the smoke in its own context (automated
  harness, no operator) records the recipes and *blocks the tag* on a
  follow-up interactive session that runs them.
- Layer transitions get a tag (`l0`, `l1`, …); structural-fix sessions
  use a descriptive suffix (`l4a-fix`).
```

**What this closes.** Going forward, no layer closes on recorded-only
smoke. The L1 and L2 historical recipes remain unexecuted; the new
convention does not retroactively block existing tags, but the next
session touching L1 or L2 surface (Properties UI, raw-source toggle,
file watcher) executes those recipes as part of its kickoff smoke.

For this session, the four-layer backfill happens before the
`l4a-fix` tag (see §5 below).

## 4. Architectural cleanup deliberately deferred

**Contract C — Navigation path split.** The kickoff proposed splitting
`handleNavigateWikilink` / `handleSelectFile` into `navigateToFile` +
`navigateWithinFile` because the four cases (cross-file ± anchor,
same-file ± anchor) were funneled through one function with a shared
no-op trap. Re-verification during the brainstorm: bugs #2 and #3 are
not reproducing against the live vault, so the immediate justification
is gone. Deferred.

**Trigger to revisit.** L4-C (Omni-Bar) will introduce
"jump to symbol within the open file" as a navigation source distinct
from wiki-link clicks; that's where the funnel becomes structurally
limiting. Revisit then with concrete L4-C requirements as input.

Spec records the deferral so future readers see *why* the split was
considered and rejected for now, not just an absence.

## 5. Session structure

### 5.1 Commits (per-task TDD)

```
1. feat(l4a-fix): Live-Preview bundle (Contract 1)
   - ui/src/editor/livePreview.ts (new, with the bundle + contract comment)
   - ui/src/editor/livePreview.test.ts (new, structural smoke)
   - ui/src/Editor.tsx (replace embedExtension wiring with bundle)
   - Closes bug #4.

2. feat(l4a-fix): embed atomic-replace + cursor-line suppression (Contract 2)
   - ui/src/editor/embed.ts (block-replace at node.from..node.to,
     active-line suppression, stored activeLineNumber)
   - ui/src/editor/embed.test.ts (extensions: range assertion,
     suppression, rebuild trigger)
   - ui/src/editor/editor-nav.test.ts (new, full EditorView jsdom
     regression for bug #6)
   - ui/src/editor/decorations.ts (retire mark-wikilink-embed:
     remove DecoKind, EmbedIndicatorWidget, wikilinkEmbedDeco,
     emission site, CSS)
   - ui/src/editor/decorations.test.ts (assert mark-wikilink-embed
     absent in fixtures that had it)
   - Closes bug #6.

3. feat(l4a-fix): resolver introspection + abort (Contract 4a)
   - ui/src/editor/embedResolver.ts (add debug, onEvent, abort,
     AbortController per fetch)
   - ui/src/editor/wikilinkResolver.ts (same shape)
   - ui/src/editor/embedResolver.test.ts (debug snapshots, events,
     abort behavior)
   - ui/src/editor/wikilinkResolver.test.ts (same shape)
   - ui/src/Editor.tsx (dev-only window.__cubical wiring)
   - No bug closed yet; instrumentation only.

4. fix(l4a-fix): <root-cause-derived> (Contract 4b)
   - Diagnostic step against ~/Developer/sandbox/cubical-l4a-smoke/
     using the new debug() and event log identifies the actual cause
     of bug #5. Fix lands wherever the evidence points (IPC handler,
     resolver promise chain, StateField effect handling, response
     deserialization, or other).
   - Regression test grounded in the diagnostic evidence. Test file
     location is determined by the root-cause layer:
       * resolver-side  → ui/src/editor/embedResolver.test.ts
       * Editor wiring  → ui/src/Editor.test.tsx
       * IPC TS layer   → ui/src/api/embed.test.ts (new if absent)
       * Rust handler   → crates/cubical-core/tests/get_embed.rs
       * Tauri command  → crates/cubical-app/tests/embed_ipc.rs
     The commit message names the cause + the test file path.
   - Closes bug #5.

5. docs(l4a-fix): conventions.md Sessions section (Contract E)
   - docs/conventions.md (new "## Sessions" section per §3.4 above)

6. docs(l4a-fix): smoke runbook + executed record
   - docs/superpowers/2026-06-04-l4a-fix-smoke-runbook.md (blank
     runbook — see §5.3)
   - docs/superpowers/2026-06-04-l4a-fix-smoke-runbook-executed.md
     (filled-in version after operator executes; committed with
     operator id + build commit)

7. docs(l4a-fix): layer-4 spec §9.2 + CLAUDE.md project-state
   - docs/layer-4-spec.md (new §9.2 "L4-A-fix closeout" entry)
   - CLAUDE.md (rewritten Project state block, l4a-fix tagged,
     L4-B as next)
```

Tag `l4a-fix` lands on the head of this sequence only after the
smoke runbook is executed green.

### 5.2 Gates

Every commit boundary, all six must be green:

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo fmt --all --check`
- `npx tsc --noEmit`
- `npm run build`
- `npx vitest run`

No commit lands red. Pre-commit hook enforces if configured; otherwise
the operator runs them manually before each `git commit`.

### 5.3 Smoke runbook

**File:** `docs/superpowers/2026-06-04-l4a-fix-smoke-runbook.md`

Single vault for all four layers: `~/Developer/sandbox/cubical-l4a-smoke/`.
Built from the L3 closeout vault + L4-A test files (per layer-4-spec
§9.1) — carries the full L3 token surface and the search-test files
forward.

**Sections:**

1. **Boot** — `cargo tauri dev`, open the vault, confirm no console
   errors, dev console available.
2. **L1 carry-over** (1 recipe, from `layer-1-spec.md` §5 closing
   note) — file renders, `onAstChange` fires on type, `vault:file-changed`
   surfaces external edits.
3. **L2 surface** (recipes from `layer-2-spec.md` §9.7) — autosave +
   conflict banner, Live Preview decorations on each in-scope Lezer
   node, Settings round-trip, theme cycle, raw-source toggle,
   Properties UI frontmatter round-trip.
4. **L3 surface** (recipes from `layer-3-spec.md` §9 Sessions B, D,
   E, G.1–G.3, H.1, H.2, J.2) — wiki-link nav, heading scroll,
   block-ref creation, tag click → virtual tag page, embed inline
   render *(bug #5 lives here)*, pending-rewrites status, rename →
   backlinks update, backlinks + unlinked-mentions panel, autocomplete.
5. **L4-A surface** (recipes 1–11 from `layer-4-spec.md` §9.1) —
   search single-term, field-scoped, fuzzy, phrase + negation;
   index status polling; rebuild; health; watcher fan-out; Building
   partial.
6. **L4-A-fix targeted repros:**
   - **Bug #4.** Open a file containing an embed; toggle raw-source
     (Cmd-E); confirm literal `![[…]]` text shows with NO widget over
     it; toggle back; confirm widget restored.
   - **Bug #5.** Open `A.md`; embed renders within ~2s.
     If stuck on "Loading…": in the dev console run
     `__cubical.embedResolver.debug()` and capture the event log via
     `const log = []; __cubical.embedResolver.onEvent(e => log.push(e));`
     Record the observed state in the executed runbook. This is the
     diagnostic step that informs commit 4b.
   - **Bug #6.** Open a file with an embed; place cursor on the line
     immediately below; press Up arrow; confirm cursor lands on the
     embed's host line (not document start).
7. **Closeout fields** — operator identifier, date, vault commit hash,
   build commit (`git rev-parse HEAD`), per-step checkbox + observation
   blank.

Each step has an expected outcome and a blank line for the actual
observation. The runbook is committed twice: blank as part of commit 6,
filled-in (with operator id + build commit + observations) after
execution.

### 5.4 Project state

CLAUDE.md "Project state" block is rewritten at session end. Names:

- `l4a-fix` tag at HEAD (specific commit).
- L1+L2+L3+L4-A smoke executed against the L4-A smoke vault, runbook
  committed.
- The three architectural contracts landed (livePreview bundle,
  embed atomic-replace, resolver observability + abort).
- The deferred Contract C with its trigger.
- L4-B as the next session, now unblocked.

Layer-4 spec gets §9.2 "L4-A-fix closeout" with the same content in
spec-formal voice.

## 6. Project-goal alignment (kickoff §"Project-goal alignment")

Each contract connects to a non-negotiable or load-bearing project
value, recorded so future readers see *why* these contracts exist:

- **Contracts 1 + 2** affect the editor's faithfulness to the `.md`
  source. Live Preview is a view over the source; extension leaks
  (problem A) and widget byte-span mismatches (problem B) both mean
  the view drifts from the source. The user's mental model is
  "what I see is what's in the file"; the contracts make that hold
  by construction.
- **Contract C deferred** — but the rationale stands: same-file
  navigation that goes through the file-load path will conflict with
  Loro CRDT's editor-state model at L7. Cheaper to split paths before
  L7 than to retrofit. Re-evaluated at L4-C.
- **Contract 4** affects plugin sandboxing (L6). Plugins will run
  async operations through the same resolver pattern; if the host
  can't introspect or cancel its own resolvers, it can't sandbox
  plugin-issued fetches cleanly.
- **Contract E** affects every layer's "closed" claim. If "closed"
  doesn't include user-visible verification, the L5 daily-driver-polish
  session inherits an unknown count of accumulated UI bugs and can't
  budget honestly.

## 7. What this session does not do

- No new Tauri commands.
- No Rust changes.
- No changes to `cubical-core`, `cubical-ast`, `cubical-index`,
  `cubical-search`, `cubical-sync`.
- No navigation path split (deferred — see §4).
- No new feature surface.
- No re-issuing of L1 / L2 / L3 / L4-A close tags. Their existing
  tags (`l1`, `l2`, `l3`, `l4a`) stand; the smoke executed during
  this session is a backfill recorded under the `l4a-fix` runbook,
  not a re-close of earlier layers.
- No `^block-id` rendering change (kept as smaller + grayer per
  operator decision during brainstorming).
- No `⎘` indicator polish *outside* its natural retirement in
  Contract 2.

## 8. Open risks

- **Bug #6's fix is unverified for pixel geometry (RESIDUAL).** jsdom
  has no layout engine (`getClientRects` is unimplemented), so the
  `editor-nav.test.ts` regression can only assert structure (inline
  replace, mounts without throwing, cursor head does not collapse to
  0) — NOT that up-arrow lands on the pixel-correct adjacent line.
  The malformed-block-decoration root cause is solid and the inline
  replace is the idiomatic CM6 fix, but **final confirmation is the
  operator's interactive smoke**. This is the *third* approach to bug
  #6 (block-widget-at-line-end → mid-line block replace → inline
  replace). Per `superpowers:systematic-debugging` Phase 4.5: if the
  re-smoke still shows a cursor problem, the embed rendering model
  gets an architecture review, NOT a fourth patch.
- **Bug #5's actual cause is unknown.** Contract 4 lands
  instrumentation; the fix lands after diagnostic evidence narrows
  the cause. **Circuit-breaker:** if the diagnostic in §3.3 points
  outside `ui/` (Rust handler, Tauri command shim, IPC serialization,
  or any other layer the session's stated scope excludes), the
  session *pauses* before commit 4b. A spec amendment commit lands
  first that:
    - names the implicated layer + the diagnostic observation
      establishing it,
    - records the estimated additional effort,
    - and explicitly extends scope.

  Only then does commit 4b land. This protects against silent
  scope-expansion — a one-line resolver fix and a multi-hour Rust
  adventure cannot share the same "fix bug #5" commit without an
  intermediate amendment.
- **Cursor-line suppression for embeds may surprise users.** Pattern
  matches existing Live Preview (Emphasis, Link), but embeds are
  block-sized, so the layout shift on cursor crossing the host line
  is larger. If the executed smoke surfaces this as a real UX
  problem, the fallback is to render a thin chrome ribbon
  ("embed source: ![[…]]") on the host line instead of fully
  revealing the source bytes. Recorded as a follow-up option, not
  in scope for this session.
- **Aborted in-flight Rust IPC calls still complete on the Rust side.**
  Contract 4's `abort()` cancels the JS-side cache-write path but
  cannot signal the running Rust task. The Rust handler keeps
  computing; the response is discarded. This is acceptable because
  every IPC call here is read-only against the vault; the wasted work
  is a small amount of CPU. If a future async surface mutates state,
  the abort interface will need backend cancellation tokens — out of
  scope here, noted for the L6 plugin sandbox spec.

## 9. Cross-references

- Kickoff: `docs/superpowers/2026-06-03-l4a-fix-kickoff.md`
- L4-A close summary: `docs/layer-4-spec.md` §9.1
- L4-A smoke vault: `~/Developer/sandbox/cubical-l4a-smoke/`
- Non-negotiables: `CLAUDE.md` §Non-negotiables
- Architecture: `docs/architecture/README.md`
- Build order: `docs/build-order.md`
- Conventions (to be amended): `docs/conventions.md`
