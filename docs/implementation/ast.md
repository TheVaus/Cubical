# Implementation — canonical AST (`cubical-ast`)

Design owner: [`../architecture/document-model.md`](../architecture/document-model.md)
→ "Canonical AST". This file records the implementation invariants only.

## The AST is deliberately slim

Only nodes Cubical itself produces and renders. Tables, footnotes, definition
lists, math, callouts and other CommonMark extensions are **not** enabled in
`pulldown-cmark`'s `Options` — cross-app importers are out of v1 scope. Adding
a node type is a document-model decision, not a parser tweak.

This constrains the AST, not what the editor may render. A form decorated over
a node that already exists — a fenced info string, a blockquote marker — needs
no node and no parity fixture; ` ```math ` renders today on exactly that basis.
See the design owner's "A fenced-code info string is not an AST-bearing
extension".

## Serialization shape is an IPC contract

**Anchors:** Inline · Block · Document

`Inline` and `Block` variants are **struct-shaped (named fields), never tuple
newtypes.** This is load-bearing, not style: with serde's internally-tagged
representation (`#[serde(tag = "kind")]`) a newtype variant whose inner type is
not a struct/map **panics at runtime** the moment it crosses the IPC boundary.
So `Text` is `{"kind":"text","value":"…"}`, not `Text(String)`.

Field renames are breaking changes — the shape is consumed by the frontend.

## Spans

**Anchors:** body_offset

Block-level nodes carry a half-open byte range `[start, end)` into the original
source, **frontmatter included** (spans are shifted by `body_offset`). Inline
nodes carry no spans; adding them would roughly double the AST's footprint and
is a deliberate decision for whichever layer first needs it.

## Frontmatter detection is strict on purpose

**Anchors:** parse · Frontmatter

Frontmatter must start at **byte offset 0** — the opening `---` is the very
first line, no leading whitespace or blank lines — with a matching closing
`---` alone on its own line. Anything looser is not frontmatter and the whole
source is body.

Being lenient here would silently reinterpret edge-case `.md` files; Obsidian,
Logseq, Hugo and Jekyll all converge on this same strict shape.

Parsing degrades rather than fails: malformed YAML logs a warning and yields
"no frontmatter"; YAML that parses to a non-mapping top-level value (a bare
scalar or list) is also treated as absent, since only mapping-shaped
frontmatter is recognised. `parse` itself is **total** — it never returns an
error. Future fallibility belongs behind a separate `parse_strict` entry point
rather than changing that signature.

## Tokenizer grammars

Wiki-link and tag tokenizers are pure functions over an `Inline::Text` value,
each yielding a run sequence. Both are **mirrored byte-for-byte in TypeScript**
(`ui/src/ast/wikilink.ts`, `ui/src/ast/tag.ts`) and held in lockstep by the
parity harness below.

Wiki-link splitting runs **before** tag splitting, so a `#` inside a wiki-link
target stays out of the tag pass (`[[note#tag]]` is one link with an anchor;
`[[note]]#tag` is a link plus a tag).

Tag grammar — the load-bearing rules:

- **Word boundary.** A `#` opens a tag only at the very start of the run or
  directly after ASCII whitespace. This is what keeps `prefix#tag` from being a
  tag while `text #tag` is one.
- **Body.** The first byte after `#` must be an ASCII letter or `_` — no
  leading digit, so `#123` is a hash followed by a number. Subsequent bytes are
  `[a-zA-Z0-9_-]`.
- **Nesting.** A single `/` followed by a non-empty segment of the same
  alphabet. A trailing `/` is trimmed (text from the slash onward).

## A note's title comes from its path in exactly one place

**Anchors:** note_title · basename · strip_markdown_extension · noteTitle

`note_name` answers "what is this file called?" for every feature that shows a
file by name: tag pages, link autocomplete, dataview results, unlinked
mentions, the search index's title field, graph node labels and link
reattachment. Three functions, one rule each — `basename` (last `/` segment),
`strip_markdown_extension` (a trailing `.md` and nothing else) and
`note_title` (both).

**Only `.md` is stripped.** A vault holds attachments whose extension is part
of their name, so `notes.txt` is titled `notes.txt` and `diagram.png` is
`diagram.png`. Stripping any final extension (`Path::file_stem`) would make
autocomplete offer `diagram` for `diagram.png` — a name that collides with a
real `diagram.md` and that `PathResolver` cannot resolve back, because
resolution indexes a candidate under its `.md`-stripped forms only. The two
rules only ever disagree on a non-`.md` extension; agreeing with the resolver
is what makes an offered title a usable link target.

**Why `cubical-ast` owns it.** The rule is needed by `cubical-engine`,
`cubical-query`, `cubical-search` and `cubical-graph`, so it has to live in a
crate all of them may depend on. The layering leaves two candidates at layer 0,
and `cubical-index` is the wrong one: `cubical-search` would have to take a
libSQL dependency to reach it. `cubical-ast` is already the lingua franca for
the link resolver, and it sits beside the wiki-link tokenizer that consumes the
same names.

Name *folding* is a different question with a different owner —
`cubical_index::fold_name`, described in
[`search-index.md`](search-index.md).

The TypeScript mirror is `ui/src/vault/noteName.ts`, which also owns note-name
validation; the two sides must agree, so change them in the same commit.

## Where the two normalizers disagree (and how parity is forced)

Rust parses with `pulldown-cmark`; the editor parses with Lezer. They differ in
ways the TS normalizer has to actively correct, or parity breaks:

- **Wiki-links are a Lezer mis-parse.** Lezer's markdown grammar reads `[[X]]`
  as `[` + `Link(dest="")` + `]`, and `![[X]]` as an `Image` wrapping such a
  Link — reference/shortcut parses with no definition in scope.
  `pulldown-cmark` emits the same input as **plain text**. So the TS side must
  first **re-flatten empty-dest Link/Image nodes back to raw bracketed text**,
  and only then scan for wiki-links. Skip that step and every wiki-link fixture
  diverges.
- **Block spans end differently.** Lezer stops at the last non-newline
  character; `pulldown-cmark` includes the trailing newline. The TS side
  extends `to` by exactly one `\n` (LF or CRLF) for headings, paragraphs,
  blockquotes and thematic breaks — **not** for code blocks, where the two
  already agree at the closing fence.
- **List items swallow trailing blank lines.** `pulldown-cmark` extends a list
  item's span through every blank line separating it from the next item (or
  from end of source), so the TS side skips any run of consecutive newlines
  after Lezer's `to`.
- **Text chunking differs.** `pulldown-cmark` fires one text event per chunk
  and joins them; the TS side coalesces adjacent text runs to match, folding
  soft line breaks to a single space.

Unrecognised nodes are silently skipped on both sides — that is what keeps the
slim-AST rule from turning unsupported syntax into an error.

The TS mirror of the AST types is the **wire-shape contract**: a discriminated
union keyed on `kind` with `snake_case` tags, matching the Rust serde
representation. Change one side and the other in the **same commit**.

## Cross-language parity harness

**Anchors:** CUBICAL_UPDATE_PARITY_FIXTURES

`crates/cubical-ast/tests/parity_fixtures.rs` owns the ground truth: parsing
each fixture and serializing to JSON must equal its `expected` field. The same
fixture file drives the TypeScript side (`ui/src/ast/parity.test.ts`), so one
ground truth keeps the editor's Lezer normalizer and the indexer's
pulldown-cmark normalizer in agreement.

When you intentionally change the AST shape, regenerate in place:

```sh
CUBICAL_UPDATE_PARITY_FIXTURES=1 cargo test -p cubical-ast --test parity_fixtures
```

Then re-run the TS side. If it disagrees, **fix the TS normalizer — never
hand-edit the fixtures.**
