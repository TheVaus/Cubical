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

## File-list virtualization

A vault can hold tens of thousands of files, and one DOM node each freezes the
webview. Only rows in the viewport plus a fixed overscan margin render, each a
fixed row height.
