# Implementation — canonical AST (`cubical-ast`)

Design owner: [`../architecture/document-model.md`](../architecture/document-model.md)
→ "Canonical AST". This file records the implementation invariants only.

## The AST is deliberately slim

Only nodes Cubical itself produces and renders. Tables, footnotes, definition
lists, math, callouts and other CommonMark extensions are **not** enabled in
`pulldown-cmark`'s `Options` — cross-app importers are out of v1 scope. Adding
a node type is a document-model decision, not a parser tweak.

## Serialization shape is an IPC contract

`Inline` and `Block` variants are **struct-shaped (named fields), never tuple
newtypes.** This is load-bearing, not style: with serde's internally-tagged
representation (`#[serde(tag = "kind")]`) a newtype variant whose inner type is
not a struct/map **panics at runtime** the moment it crosses the IPC boundary.
So `Text` is `{"kind":"text","value":"…"}`, not `Text(String)`.

Field renames are breaking changes — the shape is consumed by the frontend.

## Spans

Block-level nodes carry a half-open byte range `[start, end)` into the original
source, **frontmatter included** (spans are shifted by `body_offset`). Inline
nodes carry no spans; adding them would roughly double the AST's footprint and
is a deliberate decision for whichever layer first needs it.

## Frontmatter detection is strict on purpose

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

## Cross-language parity harness

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
