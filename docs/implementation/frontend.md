# Implementation — frontend (`ui/`)

Design owner: [`../architecture/ui.md`](../architecture/ui.md). Component-library
rules live there (§11.6); this file records frontend implementation invariants.

## IPC is a single chokepoint

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
compile instead of silently reading `undefined`.

## The frontmatter splitter mirrors Rust byte-for-byte

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

## App owns the write path

Per-file state lives in `App`, not the editor, because the buffer the user is
*leaving* must be flushed **before** the next file loads — the editor is too
local to know when that happens.

- `seenHash` — the file as of the last read or own-write.
- `lastWrittenHash` — the most recent successful write, used to drop the
  watcher's own-write echo before any external-edit logic runs.

Autosave is a single ambient debounce; flush triggers are idle, blur, file
change, and quit.

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

## Command registry is pure substrate

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
block field, the dataview block field and the property-ref field, each with its
base theme.

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
