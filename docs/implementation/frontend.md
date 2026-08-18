# Implementation — frontend (`ui/`)

Design owner: [`../architecture/ui.md`](../architecture/ui.md). Component-library
rules live there (§11.6); this file records frontend implementation invariants.

## IPC is a single chokepoint

**Anchors:** invoke · Channel · UnlistenFn

Components call typed functions from `ui/src/api/ipc.ts` — **never raw
`invoke()`, never `@tauri-apps/api/*` directly.** The module is named `ipc.ts`
rather than `tauri.ts` so a transport swap doesn't leave a misleading filename;
a growing API surface is then a one-file change.

Every command passes its arguments under a single `req` key, matching the Rust
handlers' parameter name. Small tests pin that on-wire envelope deliberately —
if a refactor changes it, they fail loudly rather than the app failing at
runtime.

The settings union is the frontend's **typed view** of a deliberately generic
backend config table (any key, any JSON value), so a mistyped key fails to
compile instead of silently reading `undefined`. It is also the only registry of
setting keys in the codebase — adding a setting starts here.

What the union does **not** protect you from is storage routing: a key beginning
`ui.` is written to the transient per-machine index instead of the durable
`config.toml`, and nothing about that failure is visible at compile time or in
tests. The rule and its consequence are owned by
[`../architecture/ui.md`](../architecture/ui.md) §12.1.

## The frontmatter splitter mirrors Rust byte-for-byte

**Anchors:** splitFrontmatter

`ui/src/ast/frontmatter.ts` must agree with the Rust splitter exactly: opener
at byte 0 on the first line, no leading whitespace, no BOM tolerance; closer
alone on its own line; CRLF tolerated; no closer found ⇒ no frontmatter.

The split runs before any markdown parsing, so a `---` at column 0 inside a
code fence is the same byte sequence as a closer on both sides. That symmetry
is intentional — the split stays cheap and unambiguous.

YAML→JSON normalization matches what the Rust serde pipeline produces:
`undefined` becomes `null`, `Map`/`Set` are flattened defensively, and very
large integer literals become numbers (the Rust side deserializes them as JSON
numbers).

## The document session owns the write path

Per-file state lives in `createDocumentSession` (`core/documentSession.ts`), not
the editor, because the buffer the user is *leaving* must be flushed **before**
the next file loads — the editor is too local to know when that happens. `App`
holds the session and calls it; it cannot reach the hashes directly, which is
what stops a future feature from open-coding a fifth `dirty = false`.

It lives outside the shell for a second reason. This is the sharpest data-loss
path in the app, and while it was closure-local inside `App` it could not be
unit tested at all. It now is, including the cases that are hard to provoke by
hand: a write that lands while the buffer changed under it, two overlapping
flushes, and an external edit arriving mid-conflict.

- `seenHash` — the file as of the last read or own-write.
- `lastWrittenHash` — the most recent successful write, used to drop the
  watcher's own-write echo before any external-edit logic runs.

Autosave is a single ambient debounce; flush triggers are idle, blur, file
change, and quit.

**An unresolved conflict suppresses every write path**, not just the debounced
one. `scheduleWrite`, `flush` and `writeBeforeUnload` all return early while
`conflictHash` is set, so no blur, tab switch or quit can resolve the banner on
the user's behalf. The banner exists because the app cannot tell which side
should win; a path that writes anyway answers that question silently, and always
in favour of the local buffer. Quitting with a conflict open therefore drops the
unsaved buffer rather than overwriting the copy on disk — the disk copy is the
one that cannot be recovered afterwards.

**A write is disowned if the document changed while it was in flight.** `reset`
bumps a generation counter that `performWrite` captures before awaiting, so a
response arriving after a vault or file switch cannot repopulate `seenHash`,
`lastWrittenHash` or `dirty` from the outgoing document.

**Seed both hashes when the caller already knows the on-disk hash** (e.g. a
file it just created). Otherwise the watcher's created-echo arrives as an
unrecognised external edit and raises a false "changed outside Cubical" banner
immediately after create.

Renames don't emit a file-changed event — that only arrives later, debounced,
from the watcher's disk-move echo. So the rename handlers proactively run the
same invalidation a file change would, or open views keep resolving stale
wiki-link targets and showing the old name.

**Skip resolver invalidation on the open file's own autosave echo.** An own
write cannot have changed another file, so cached embed and wiki-link
resolutions stay valid; invalidating anyway only thrashes embed-card height and
jumps the viewport. Other-file changes and genuine external edits still
invalidate.

## Tabs

**Anchors:** TabStrip

The active-document model lives in an immutable `TabSet` (`tabs/tabModel.ts`),
in the style of `navHistory.ts` — `App` holds one `tabs` signal and derives the
old `view()` / `selectedPath()` accessors from it, so every existing read site
kept working untouched.

**Only the active tab can be dirty, because activating a tab flushes autosave
first.** The autosave machinery is global — one `dirty`, one timer, one
`pendingWrite`, all inside the single document session. Lifting that to per-tab
state is the sharpest
data-loss hazard in the app: tab B's timer firing against tab A's buffer writes
A's text to B's path. Flushing on activation removes the hazard by construction.
The activation ordering lives in exactly one tested place (`tabs/activation.ts`);
never add a second path that switches tabs without going through it, and never
introduce per-tab `dirty` — a bug that seems to need it is almost always a
missing flush.

**Tab ids are derived from the view** (`file:<path>`, `tag:<path>`), so opening
an already-open document activates its existing tab instead of duplicating it.
That removes identity bookkeeping, but it also forces **nav history to be
global**: dedupe-on-open makes a tab *be* a document, so a per-tab back/forward
stack could only ever hold the one path it was created with. History is one
app-wide `NavState`, and back/forward may change which tab is active.

**Keep-alive editors.** Each tab keeps its `Editor` mounted (`<For each={live()}>`
with a `display: contents | none` wrapper), capped by an LRU (`editor.live_tab_limit`,
default 8, clamped to ≥1). Swapping `value` on one shared instance would reset
CodeMirror's undo/scroll/cursor on every switch. Because the plan's single
`selectedContent` signal cannot drive N mounted editors without the hidden ones
clobbering each other, editor content is a **per-id store** (`contents[id]`);
each editor binds to its own key, so a switch never touches a hidden buffer.
Returning to a *live* tab preserves its CodeMirror state for free: activation
reloads from disk, but the flush-on-leave invariant guarantees disk equals the
editor's buffer, so `Editor`'s `current !== next` guard makes the re-dispatch a
no-op. An *evicted* tab is always clean (same invariant), so it simply remounts
and **rehydrates from disk** — the markdown-is-source-of-truth rule applied
literally; there is deliberately no content cache for cold tabs. The eviction
effect prunes both `editorApis` and `contents` for any id no longer live.

**Lifecycle edges.** Rename remaps the tab ids (`remapTabPaths`) *and* the
keep-alive `mru` / `contents` keys, so the renamed active tab keeps its content;
`editorApis` self-prunes because the renamed id leaves `live()`. External deletes
are handled in `refreshFileList` via `dropMissingTabs`, gated on
`ScanStatus::Complete` so a partial mid-scan file list never drops a legitimately
open tab.

**Sessions are machine-local**, in the Tauri app-data dir keyed by vault path —
not `.cubical/config.toml`. Which tabs you had open should not travel with a
vault shared between machines or people (the recent-vaults precedent). Nav
history is not persisted; a restored tab starts with empty history, the way a
browser treats a restored tab. Persistence is gated behind a `tabsReady` flag:
a vault switch clears the tab set to empty *before* restore reads the saved
session, and an ungated persist effect would save that empty set — which the
Rust side reads as "forget this vault" — and wipe the session before it is read.

**Non-file tabs are excluded from both the keep-alive pool and persistence, by
allow-list rather than deny-list.** `live()` computes from `liveFileIds`
(`tabs/lru.ts`), which filters the `mru` list and the active id down to
file-backed ids *before* applying the `live_tab_limit` cap — so a non-file tab
never occupies a capped LRU slot and can never evict a warm file editor's
CodeMirror state. Filtering only at the render site (`<For each={live()}>`)
is not enough: that keeps the tab `Editor`-free while still letting it consume
a slot. `isPersistableTab` likewise allow-lists `file`/`tag` instead of naming
the kinds to exclude, so any future non-file tab is left out of session
persistence by default rather than by remembering to add it.

**Known exposure, unchanged from single-file editing:** if the flush write
fails, activation still proceeds with unflushed content. Today's file-switch has
exactly this exposure; tabs neither widen nor narrow it.

## Integrity panel

**Anchors:** IntegrityPanel

Third right-sidebar tab, alongside Backlinks and Mentions (which is why that
body is a `<Switch>`/`<Match>` now — two panels fit a `<Show>` fallback, three
do not). It reads `list_dangling_links` and is otherwise the same shape as
Backlinks: a pure reducer (`integrityState.ts`) holds
idle/loading/empty/loaded/error, the component holds only the request token and
the transient open-popover and busy-candidate ids. Rank labels and the action
label live in the reducer module too, so the wording is asserted by a plain
vitest rather than by DOM scraping.

**The click that repairs must name the file it repairs to.** "Reattach to…"
opens a `Popover` of ranked candidates; nothing is sent until the user clicks a
specific candidate, whose accessible name is the whole sentence — `Reattach
[[plan]] to notes/planning.md`. There is no bulk action and no default
selection: the engine will rewrite the user's `.md` files, so the confirmation
has to carry the actual consequence, not a generic yes. A group with no
candidate still lists (the residue must stay visible) with the action disabled
and a title explaining that the note has to be relinked by hand.

After a repair the panel reloads itself and calls `onRepaired`, which nudges the
shared right-sidebar refresh tick so Backlinks and Mentions re-read the vault
they no longer agree with.

## Command registry is pure substrate

**Anchors:** COMMAND_DEFAULTS

`ui/src/core/commands.ts` holds types, the default binding table, key-string
matching and command resolution — **no DOM, no Solid, and no import from any
feature module**. The adapters (the App-level `keydown`, the CodeMirror keymap)
inject the `run` closures and wire it to their runtime.

Keep it that way: the moment the registry imports a feature, the "one place
that defines shortcuts" property is gone. Adding a command is a single entry in
the default table — the keymap, the global handler and the Settings UI are all
derived from it.

Rebinding is layered on top as a **diff, not a snapshot**:

- A command with no override falls through to its default, so a later change to
  a default is picked up automatically instead of being frozen by a stale
  saved snapshot.
- Resolution only ever iterates the default table, so an override naming a
  command that no longer exists is silently ignored rather than resurrecting it.
- `global` and `editor` are **independent key spaces** — the same chord in the
  other scope is not a conflict.

## Substrate vs feature ownership

`ui/src/core/` is substrate: it owns the always-on plumbing and knows nothing
about any feature. Two boundaries worth preserving:

- **Settings substrate owns the side-effects only** — persist-on-change and
  seed-on-vault-open. Each setting's *reactive value* stays owned by the
  feature that renders it. That is deliberate: it keeps the compile-time
  key→value typing instead of collapsing into a stringly-typed record. The
  substrate persists and seeds; it never decides what a setting *means*. A
  failed read is logged and skipped, leaving the feature at its initial value.
- **Vault session** holds the open vault's identity and scan lifecycle.
  Features read from it; it never reaches back into them.

## Editor compartments

`Editor.tsx` owns its DOM and the `EditorView`; Solid stays out of it so the
main-thread contract holds. Behaviour is swapped through CodeMirror
compartments rather than rebuilding the view:

| Compartment | Reconfigured when |
|---|---|
| Live Preview decorations | raw-source toggles (swapped for a no-op) |
| Raw-source coloring | raw source **and** the colorize setting are both on |
| CM6 chrome theme | the resolved theme flips |
| Autocomplete | a different vault opens (`null` provider ⇒ no-op) |
| Keymap | a shortcut is remapped in Settings |

Decorations and raw-source coloring are **mutually exclusive by construction**
(one is gated on raw source, the other on its negation), and neither references
the other. Lezer parsing keeps running in raw mode, so the AST callback is
unaffected.

Anchor scrolls are **queued**, not fired synchronously: the editor replaces its
buffer via a deferred effect, so a scroll issued right after selecting a file
would race the load. A queued request supersedes any previous one.

## Decorations

**Anchors:** EditorView · Decoration

Decoration source is **Lezer exclusively** — a deliberate deviation from the
canonical Rust-mirrored AST, which abstracts away the byte-precise marker token
positions decorations need. The canonical-AST path is a separate, unaffected
consumer. `collectDecorations` is the pure, view-independent core; the plugin
is a thin wrapper.

Reveal has **two modes**: line-level markers (headings, fences, quotes, list
dashes) reveal whenever the cursor shares their line; inline tokens (emphasis,
code, link brackets and URL, wiki-links, tags, block ids) reveal only while the
cursor actually touches the token — being elsewhere on the same line is not
enough.

One decoration is special: hiding a top-of-file frontmatter block is a **block**
decoration, which CodeMirror forbids from a view plugin, so it is supplied by a
separate state field. It is also not Lezer-sourced — the markdown grammar does
not model frontmatter — so it scans the document directly.

## The Live Preview bundle is a hard contract

`ui/src/editor/livePreview.ts` is the single composed extension installed into
the decoration compartment. Raw-source mode reconfigures that compartment to
`[]`, which structurally kills every transformation inside the bundle.

**Every preview-only extension MUST be a member of this bundle.** Adding one to
the editor's base extension list, or to a separate compartment, is a bug: raw
source will not kill it. Current members are the decoration plugin, the embed
block field, the block-renderer field, the display-math field and the
property-ref field, each with its base theme.

`livePreviewFor(rawSource, mathEnabled)` — not the bare bundle — is what the
editor installs. Settings that only gate a preview extension belong in that
function as a facet, so they ride inside the compartment raw source already
kills, instead of earning a compartment and a reconfigure effect of their own in
`Editor.tsx`.

## Fenced blocks go through the renderer registry

`ui/src/editor/blockRenderers.ts` owns **one** state field that finds every
`FencedCode` node, matches its info string against the registered renderers, and
replaces the block with a widget. A renderer is data — `languages`, a
`frameClass`, a `render(source, ctx)` returning a DOM node, and optional
`active(state)` / `revision(state)` hooks — contributed through
`blockRendererFacet`.

**Do not write a second fenced-block state field.** Before the registry, csv and
dataview were two hand-copied fields with identical scan-and-replace logic, and
math would have been a third; the copies had already drifted (only one trimmed
its source, only one honoured a facet). One field means cursor suppression,
atomic ranges and rebuild triggers are decided once.

The two hooks exist because a renderer may be inert or stale for reasons the
field cannot see:

- `active(state)` decides whether to decorate **at all**. Dataview returns false
  with no runner in the facet; math returns false when its plugin toggle is off.
  A renderer that cannot draw must say so here — returning an empty node from
  `render` still blanks the user's source.
- `revision(state)` is widget identity beyond the source text. Async renderers
  need it: dataview's is `runnerId:version`, so a settled query redraws, and a
  *swapped* runner redraws even when the new one's version collides with the old
  one's. A pure renderer omits it.

Registration order is priority — the first renderer claiming a language wins, so
a plugin cannot silently shadow a built-in one.

**The registry is the pre-ABI shape of the plugin block API** (issue #61), which
is why it is data-driven rather than a switch: a WASM plugin contributing a block
renderer is the same registration with `render` crossing the sandbox boundary.
It is *not* itself a plugin boundary — everything in it is first-party, in-process
and unsandboxed. Do not treat it as one.

## Block widgets and the cursor

Rendering block-sized content inside a text line is the root of CodeMirror's
inline-vs-block cursor tension. The settled primitive is a **whole-line atomic
block replace** over `[line.from, line.to)` — the same shape as the
frontmatter hide, which has never had a cursor bug.

Two earlier approaches failed and are recorded so they are not retried:

| Approach | Result |
|---|---|
| Inline-replace *widget* over the token | cursor-correct, but block content never got height — "invisible until click" |
| Zero-length block *widget* at line end | rendered fine, but jumped the cursor — it fought a line that still held text |

Consequences of the chosen shape:

- An embed renders as a card **only when its token is alone on the line**
  (whitespace padding still counts as alone). Mid-line embeds stay raw text.
- The replace ranges are registered as **atomic** so horizontal cursor motion
  skips cleanly over a card. Because cursor-line suppression drops the
  decoration on the active line, the range is non-atomic exactly when you're
  editing that line — click-to-edit still works.
- **Atomic ranges do not fix vertical motion.** CodeMirror computes
  ArrowUp/ArrowDown from *screen geometry*: a card is one document line but many
  screen rows, so a one-line-height step lands inside the card and snaps past
  it, overshooting by one or more document lines and making the embed line
  unreachable. The fix lives at the input layer — detect an overshoot of more
  than one document line (which only happens at a tall block) and correct to
  exactly one. Normal and soft-wrapped lines never overshoot and keep default
  visual motion.

### Frontmatter hide: two separate gotchas

- It must come from a **state field, not a view plugin** — CodeMirror rejects
  block decorations from plugins ("Block decorations may not be specified via
  plugins") because layout derives from the state before plugins run. It still
  lives inside the Live Preview bundle so raw mode reveals the YAML.
- Its range must end at the **closer line's own end**, never at the next line's
  start. A block-replace whose `to` coincides with a line start makes
  CodeMirror drop that line's line-decoration, stripping the decoration off a
  heading, code block or blockquote sitting immediately after the frontmatter.

Frontmatter is also detected by a direct document scan rather than a Lezer
walk, because the markdown grammar reads a YAML preamble as
`thematic break + text + thematic break`.

## Resolver caches

Wiki-link, embed and property resolvers share one shape: a per-vault cache over
an IPC, deduping concurrent fetches and notifying subscribers, with a facet
supplying `{ get, fetch }` and an effect dispatched back to trigger rebuilds.
`invalidate()` runs from the file-changed listener so newly-resolvable targets
re-render without a reload.

Three invariants worth keeping:

- **Widget identity folds in the resolver's `version()`**, a counter bumped on
  every cache mutation anywhere. Keying identity on only a widget's *own* cache
  entry leaves **nested** placeholders frozen forever — a parent's entry never
  changes when a descendant resolves. The version is stable across unrelated
  edits, so plain keystrokes don't tear widgets down.
- **Failures cache an `unresolved` entry**, so a failing target doesn't
  re-enter the IPC on every rebuild.
- **Invalidate races the settle.** If `invalidate()` lands between a fetch's
  cache-write and the subscriber waking, the subscriber sees an empty cache
  *and* no in-flight fetch — it must re-kick, or that pending resolution hangs
  forever.

Embed bodies render as **plain text** (no markdown parsing) up to a depth
ceiling owned by [`../architecture/document-model.md`](../architecture/document-model.md);
cycles are caught by growing a chain of resolved paths, seeded with the open
note's path so a self-embed is detected.

## One renderer per viewer format

`viewer/render.ts` holds framework-free DOM builders — table, plain text,
image. Three surfaces consume them and none of them owns a second copy: the
file tab (`viewer/FileViewer.tsx`, which mounts a fragment rather than
duplicating the markup in JSX), the embed body (`editor/embedRender.ts`), and
the ` ```csv ` widget (`editor/csvBlock.ts`).

That is what makes "an embed looks like the file's own tab" a property of the
code rather than a convention to maintain — both call `renderViewerPayload`.
A new viewer format is added once, in `render.ts`, and appears in all three.

## Viewing, source mode, and editing are three different permissions

A file can have a viewer without having a source view, and a source view
without being editable. Three predicates in `viewer/viewerKind.ts` keep them
apart, and they widen strictly:

- `hasViewer` — Cubical can render it at all. Everything else gets the
  unsupported badge in the tree and refuses to open.
- `supportsSourceView` — the raw-source toggle means something. True for text
  and delimited; an image has no source, so the toggle is disabled rather than
  silently inert.
- `isEditableText` — the engine will read *and write it back*. Plain text
  only (`.txt`, `.text`, `.log`).

`isEditableText` is the frontend half of a boundary the engine enforces:
`editable_as_text` in `crates/cubical-engine/src/commands/vault.rs` gates both
`read_file_text` and `write_file_text`, and the two lists must agree. The
engine is the authority — a frontend that asked to write a `.png` would be
refused, not obeyed.

Delimited files are deliberately absent from `isEditableText`. The table is a
*rendering* of the bytes; making it editable means owning quoting and escaping
rules, which is a feature, not a widening of this predicate. So a `.csv` gets
a viewer and a source view, and stays read-only in both.

Editing a plain-text file reuses the note path wholesale — same tab, same
editor, same autosave, same external-edit conflict detection — by letting
`viewerPath()` return null in source mode so the editor branch takes over. One
thing does not carry over: the title bar is read-only for non-Markdown,
because `isValidNoteName` rejects every dotted name, so a rename typed there
could only ever fail.

## WKWebView event quirks

Two platform behaviours shape every click interceptor (wiki-link, tag,
dataview):

- **The caret moves on `mousedown`, before `click` fires.** Navigation
  therefore runs from a **capture-phase `mousedown`** handler that reads the
  target's `data-path`, not from a click handler. Rendered widgets are replace
  decorations with no backing syntax node, so there is nothing to hit-test
  against anyway.
- **Mouse events are dispatched on the text node.** Chromium tends to dispatch
  on the visible `<span>` of a mark decoration; WebKit/WKWebView dispatches on
  the `Text` node *inside* it. `closest()` only exists on `Element`, so a text
  target must be lifted to its parent first — otherwise the lookup silently
  returns null, nothing calls `preventDefault`, and the click falls through.
  That single omission kept one click bug alive through two prior fix attempts,
  so keep the lift in one shared helper rather than per interceptor.

## Minimap

CodeMirror no longer scrolls internally — the theme sets the scroller to
`overflow: visible` so the editor grows and the *page* container scrolls. The
minimap must therefore read scroll geometry from the nearest scrollable
ancestor, **not** the editor's own scroll element.

It is strictly read-only: it drives that container's scroll position and never
dispatches a document change, preserving the "Solid stays out of CM editing"
contract. Doc changes drive a debounced relayout; scrolls drive a cheap
rAF-throttled repaint that reuses the existing layout.

## Testing note

jsdom implements no layout, so CodeMirror's vertical-motion path throws on
`getBoundingClientRect`. Tests that exercise it stub those to a deterministic
single-line-height layout — the coordinates need only be self-consistent enough
for CM's "find the line above/below" search to terminate.

## Theme generation

The CM6 chrome theme is built from the **computed** token values read off the
root element, rather than letting injected CSS carry raw `var(--…)` references.
That way editor chrome and the Solid UI derive from one token surface, and a
user-installed theme re-themes the editor with no editor-code change.

**It must be rebuilt only after the theme attribute has been written**, or
computed styles still reflect the outgoing theme.

## Autocomplete

Trigger detection and insert-text construction are pure and unit-tested; the
completion sources add Lezer "inside code" gating plus an injected provider, so
tests stub the IPC. There is no caching — CodeMirror's `validFor` filters in
place between keystrokes and the dropdown is short-lived. Provider failures
resolve to an empty list, so a transient IPC error shows no candidates instead
of throwing into the completion pipeline.

The link trigger stops at `#` and `|`; in-bracket anchor completion requires the
literal `#^` so it can never collide with heading completion.

**Fence-language completion is derived from the block-renderer registry, not
from a list.** `fenceComplete.ts` builds its options by calling
`activeRenderers` — the same function `blockRenderersField` calls to decide what
to render — so the languages offered are exactly the ones that will produce a
rendered block, and a renderer switched off by its setting stops being offered
at the same moment it stops rendering. A hand-maintained language list would
drift from the registry in both directions: a language offered with nothing to
render it, and a renderer nobody can discover. Give a renderer its `languages`
(or a richer `completions`) and both surfaces follow; when two renderers claim
the same language the first registration wins, and a language prefix ranks above
an alias prefix.

The trigger fires only where a fence is actually being opened — it reuses
`isOpenAbove` from `autoClose.ts` rather than matching backticks, so typing
inside an open block does not offer to open another.

## Offset conversions

CodeMirror positions are UTF-16 code units; backend commands that locate a line
(such as minting a block id) take **UTF-8 byte offsets**. Convert at the
boundary — this is a silent corruption source on any non-ASCII document.

## Popover dismissal

The DS `Popover` renders a transparent full-viewport backdrop below the panel
but above everything else, and the backdrop's own click handler closes it.
Because the backdrop intercepts the click, one click can never reach both the
backdrop and the trigger — this **structurally** prevents the close-then-reopen
race a document-level listener causes. Escape is an additional affordance, not
a replacement.

## List identity and Solid reconciliation

Solid's `<For>` reconciles **by object reference**. Handing it a freshly
allocated object each render — even with identical field values — tears down
and remounts that row's DOM.

Every list builder that re-derives its output from scratch on a signal update
(file tree, backlinks, mentions, search results) must run its result through
the list-stability helper, which reuses the previous frame's references for
unchanged items. Skip it and unrelated rows lose their mounted DOM (and any
in-progress interaction) on every refresh.

## Properties: the draft guard

Every editable cell holds a local draft and **ignores incoming `value` prop
changes while it is focused** (or, for chip rows, while any chip is being
edited). Without this, an AST-change-driven refresh clobbers whatever the user
is typing. Drafts commit on blur or Enter.

Related rules in the same surface:

- A rejected draft (empty or non-numeric where a number is required)
  **reverts to the last committed value** rather than writing an invalid value
  into the frontmatter.
- A toggle has no draft state, so it commits immediately — no guard needed.
- Type coercion always yields a *valid* value of the target kind, so the
  rendered cell kind and its value can never disagree. When a conversion
  discards information it is flagged lossy and the row shows a
  non-dismissable warning preserving the original. **Nothing is silently
  destroyed.**
- Currency stores a **bare number** in the YAML; the symbol and grouping are
  display-only. Dates use a curated format table with explicit validation
  regexes — deliberately no date library — so adding a format is a one-row
  change.

## Fetching effects: untrack your own writes

Panels that fetch on a signal change (backlinks, unlinked mentions) follow two
rules together:

- **Guard against late responses.** Capture an in-flight token in the closure so
  a slow response from a previous fetch can never overwrite a newer one's state.
- **Read your own state through `untrack`.** The reducers return a *fresh object
  reference* every time, so a tracked read of the panel's own state inside the
  effect that writes it forms a self-trigger loop. This is not theoretical: it
  blew the JS stack synchronously, and once a file was selected it spun on the
  fetch-start state and never reached loaded, because each iteration's token
  superseded the previous fetch. A regression test covers it.

## Frontmatter serialization

The serializer edits the **existing block in place**, reusing the parsed node of
every unchanged key. That is what lets foreign comments and blank lines survive
an edit to some *other* property — a naive re-emit would silently reformat the
user's file, which the source-of-truth rule forbids.

- Types are stored as a trailing `# type:<token>` comment on the key's line.
  The token may contain spaces (date formats) and parentheses (enums), and a
  comment counts as a type hint **only** when its token resolves to a known
  kind — otherwise it's an ordinary comment and is left alone.
- **Anchors and aliases remain unmodelable.** Editing a value shared by
  reference is genuinely ambiguous, so the Properties UI renders read-only
  rather than guessing.
- Date formats that share a regex are disambiguated by **range validation**, so
  `17/06/2026` falls through to day-first rather than parsing as month 17.
  Cross-format conversion is best-effort and flags lossy narrowing.

## Small single-owner helpers

These exist to stop a rule being re-implemented per call site:

- **Error narrowing.** IPC rejections arrive `{ code, message }`-shaped; other
  failures are `Error`s or arbitrary values. One helper turns any caught value
  into a human-facing string (it replaced ~15 copies of the same narrowing).
- **Rename path following.** When a folder is renamed, the open file follows it
  — but the check requires a full `folderPath/` **segment boundary**, so a
  sibling that merely shares a prefix (`projects-archive` vs `projects`) must
  not match.
- **Nav history** is a session-scoped list-with-a-cursor, not persisted.
  Pushing the current entry again is a no-op, and pushing after going back
  drops the forward entries (standard browser branching).
- **OmniBar ranking** is pure. Typo tolerance comes from Sellers'
  k-approximate substring search, which tolerates a *substituted* character,
  not merely a skipped one — a plain subsequence match can't do that.
  Subsequence matching indexes by code point so multi-byte characters align.

## File-list virtualization

A vault can hold tens of thousands of files, and one DOM node each freezes the
webview. Only rows in the viewport plus a fixed overscan margin render, each a
fixed row height.
