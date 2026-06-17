# Kickoff — L3/L4-A consolidation session

> Copy the body below (everything under the horizontal rule) into a fresh Cubical session as the opening message.

---

Start a structural-debt session. Tentative name: **L3/L4-A consolidation — Live Preview, embed widget, navigation, and resolver observability.** This is *not* L4-B. Treat L4-B as gated behind this work.

## State of the project

L4-A closed at tag `l4a` (commit `99cd0ff`). `docs/layer-4-spec.md` §9.1 has the close summary. CLAUDE.md non-negotiables apply: plain `.md` files are the source of truth, the vault is portable, no UUID injection before L7, desktop-only v1, WASI/WASM for plugins. None of those should be relaxed to solve anything below.

## What surfaced

Interactive smoke against `~/Developer/sandbox/cubical-l4a-smoke/` (built on the L3 smoke vault) turned up six visible bugs that map back to L3 sessions B / G / H — none of which had interactive smoke run at their close. Reproducible behaviors:

1. `^block-id` markers render literally (muted-styled) in Live Preview rather than being hidden — visible from any file with a referenced block (e.g. `^abc123` in `A.md`).
2. `[[Aliased Note#Heading section]]` from inside `Aliased Note.md` doesn't scroll to the heading.
3. `[[notes/inbox/Stuff|self-ref via path]]` from inside `notes/inbox/Stuff.md` — click registers but nothing visible happens.
4. Toggling to raw-source mode keeps embed block widgets rendered over the raw text.
5. `A.md`, `B.md`, `C.md` embeds stay on the "Loading…" placeholder indefinitely.
6. Up-arrow in a file containing an embed jumps the cursor to the start of the document instead of one visual line up.

## The trap to avoid

The previous session initially proposed six point fixes. On critique, five of them were bandaids — they would each unblock the immediate symptom and reintroduce the same class of bug the moment L4-B added its first new editor decoration or its first search-result-click navigation. The wider problems behind the symptoms are:

### A. Live Preview gating is not a contract

Some transformations (wiki-link / tag / block-id decorations) sit inside `decorationCompartment` and are correctly disabled by the raw-source toggle. Others (`embedExtension`) live in the base extension list and ignore the toggle. There is no single registry of "transformation layers." Each new layer (and L4-B will add at least one — editor-side search-hit highlighting) has to remember to join the gating, with no enforcement. **Bug 4 is this.**

### B. The embed widget's CodeMirror layout contract is incomplete

It is a block widget at `line.to` with `side: 1`, an estimated height, and no `lineBreaks` / `coordsAt` / `ignoreEvent`. It claims vertical space without telling CM6 how cursors, selections, find-next, or click-to-position should traverse it. **Bug 6 is one symptom of this; click-into-embed, selection-across-embed, search-within-buffer all have latent bugs from the same root.** The deeper question: should embeds be block widgets attached to the end of the host line, or atomic decorations replacing the `![[…]]` token's actual byte span? The latter is the model where "this byte range renders as this visual content" is true by construction.

### C. Same-file and cross-file navigation share one path that shouldn't

`handleNavigateWikilink` runs through `handleSelectFile` (which early-returns on same-file) and then maybe `scrollToHeading`. Four cases (cross-file ± anchor, same-file ± anchor) are funneled through one function with conditional branches and one shared no-op trap. **Bugs 2 and 3 are this.** L4-B (search result click → scroll) and L4-C (Omni-Bar → jump to symbol) will inherit the same muddle.

### D. Async resolver lifecycle has no observability and no cancellation

`EmbedResolver` and `WikiLinkResolver` are created per vault open. There is no debug accessor for "what's the cache state right now?", no abort path for in-flight fetches at vault swap, no visible signal when a `then`/`catch` fails to fire. **Bug 5 cannot be root-caused without instrumentation, and we'll repeat that pattern for every async cache in L4-B/C/D and the plugin layer.**

### E. Interactive smoke deferred is becoming compound debt

L1, L2, L3, and L4-A all closed with recipes recorded but not executed. The user is now hitting four sessions' worth of unverified UI in one batch. The closeout DoD says "smoke recipes recorded" — it should say "smoke recipes executed."

## Project-goal alignment for the fixes

Each wider problem connects to a non-negotiable or load-bearing project value:

- **(A) and (B)** affect the editor's faithfulness to the `.md` source. Live Preview is a *view* over the source — extension leaks and widget byte-span mismatches both mean the view drifts from the source. The user's mental model is "what I see is what's in the file"; we owe that.
- **(C)** affects future sync (L7) and undo semantics. Same-file navigation that goes through the file-load path will conflict with Loro CRDT's editor-state model. Splitting paths now is cheaper than retrofitting at L7.
- **(D)** affects plugin sandboxing (L6). Plugins will run async operations through the same resolver pattern; if the host can't introspect or cancel its own resolvers, it can't sandbox plugin-issued fetches cleanly.
- **(E)** affects every layer's "closed" claim. If "closed" doesn't include user-visible verification, the L5 daily-driver-polish session inherits an unknown count of accumulated UI bugs and can't budget honestly.

## What the session should produce

Open. Don't prescribe before brainstorming. Some options worth considering:

- A **single architectural session** covering A–D (one feature surface: "make the editor's Live Preview / embedding / navigation / async-resolver contracts complete"). Would violate "one feature surface per session" if read strictly, but the four problems share an editor-state-model spine — splitting them may produce four small sessions that each leak around the seams of the others.
- **Four small sequential sessions**, A → B → C → D, each landing one architectural piece. Cheaper per-session, but takes longer wall-time and the bugs persist meanwhile.
- A **"fix the bugs visibly first, then refactor underneath"** approach where #4 and #6 get one-liner bandaids on day one to unblock smoke, then A–D land as architectural follow-ups before L4-B. Risks the bandaids becoming permanent.

The brainstorming session should pick one of those (or something else) deliberately. Whichever it is, it should also resolve E by updating `docs/build-order.md` or `docs/conventions.md`'s session-close ritual.

## What's genuinely unknown (do not paper over)

- **Bug #5's actual cause** needs runtime instrumentation. The deadlock hypothesis I floated in the previous session was poorly grounded — `get_embed` doesn't touch `vault.search()`. The bug could be in the IPC, the resolver's `.then`/`.catch`, the StateField's `embedResolverUpdated` handling, the Tauri serialization of `GetEmbedResponse`, or somewhere else entirely. Don't propose a fix until console.log evidence narrows it.
- **Bug #1** is a design call (hide vs. mute vs. small affordance), not a code-level fix. Ask the user.
- **Bug #2's heading-text comparison** may be tripping on non-obvious string details (smart quotes, NBSP, trailing whitespace) rather than the timing race I hypothesized. Instrument before fixing.

## Constraints inherited from the user

Main checkout + branches, no worktrees. Short, layer-sized sessions — but this one is architecturally cross-cutting; if the brainstorm settles on "one session," be honest that it's not a feature session. TDD. Per-task commits. All six gates green at close. Interactive smoke executed before tagging.

## Process

Start with the `superpowers:brainstorming` skill. Frame the brainstorm around the five wider problems, not the six surface bugs. The bugs are evidence; the problems are the work. The output of brainstorming should be a design spec that names the contracts being established (transformation-layer registry semantics, embed widget byte-span model, navigation path split, resolver observability/abort interface) and lays out which bugs each contract closes. Then `superpowers:writing-plans` against that spec.

Tag the result `l4a-fix` (or whatever the brainstorm settles on) when complete. **Do not start L4-B until this is closed with executed smoke.**
