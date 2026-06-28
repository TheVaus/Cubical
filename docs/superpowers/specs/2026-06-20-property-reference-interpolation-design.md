# Property Reference Interpolation — Design

**Date:** 2026-06-20
**Status:** Shipped on `feat/property-ref-interpolation` (Approach A,
default-on core plugin). Implementation: [`docs/superpowers/plans/2026-06-20-property-reference-interpolation.md`](../plans/2026-06-20-property-reference-interpolation.md).
**Relationship:** Independent of the typed-properties
[vault registry](2026-06-20-typed-properties-vault-registry-design.md) — v1
renders raw scalars, so it takes **no** dependency on type storage and can
land on its own schedule. Type-aware formatting is a later additive layer
that *would* lean on the registry.

> **Interaction note (added 2026-06-27) — dotted targets that name a file.**
> A dotted target like `[[Report v1.2]]` tokenizes as a property-ref (note
> `Report v1`, property `2`) even though the user means the *file*
> `Report v1.2.md`. Previously such occurrences were silently dropped from the
> link index (no backlinks, no rename-follow). As of 2026-06-27 the link
> extractor applies **file-existence-wins precedence**: a cross-file property-ref
> whose reconstructed dotted target resolves to a real file is indexed as a
> wiki-link, and renaming that file rewrites the whole `[[…]]` token
> (`crates/cubical-core/src/vault/links.rs::keeps_link_row` +
> `pending.rs::rewrite_wiki_link`). Genuine property-refs (no matching file) are
> still left for this feature. **When interpolation resolution runs, it must
> respect this precedence** (or consciously override it): if `note.prop.md`
> exists, the occurrence is currently a navigational link, not an interpolation.
> The collision is rare but real and is the one spot where the two features meet.

---

## 1. Why

A user writing a note — say a D&D character — wants to refer to a structured
value (`age`, `hp`, `alignment`) without copying the literal number into
prose, so the prose stays correct when the value changes. Today Cubical has
no inline single-value interpolation: **Dataview** queries *across* files and
renders whole `LIST`/`TABLE`/`COUNT` blocks ([`ui/src/editor/dataview.ts`](../../../ui/src/editor/dataview.ts)),
and **wiki-links** navigate but don't surface values. This feature fills the
gap: pull one frontmatter scalar and splice it inline, read-only, at display
time. Cubical's own docs already anticipated it — the inline-comments spec
lists "Dataview-driven / computed dynamic properties" as a desired follow-up.

It honors the non-negotiables: interpolation is a **display-time** transform.
The `.md` keeps the literal `[[Gandalf.age]]` text; the rendered view shows
the value. Source of truth stays byte-for-byte.

## 2. Syntax & semantics

```
[[Gandalf.age]]   → top-level `age` key from note "Gandalf"
[[.age]]          → `age` key from the CURRENT note (self-reference)
```

- **Dot is the property separator**, split at the **first** dot. Left of it
  resolves to a note (empty = self); everything right is the property name.
- A valid target therefore contains **no dot**, so a note whose filename
  contains a dot (`2026.06.20.md`) is **not** addressable by a plain `[[ ]]`
  link. See §5.
- **Top-level keys only.** `[[a.b.c]]` parses as note `a`, property `b.c`,
  which won't match a top-level key → broken-ref (§3). Nested paths are
  deferred.
- **`.md` in links is dropped entirely** — basename resolution never needed
  it, and under the dot rule `[[Gandalf.md]]` would otherwise read as
  property `md`.
- **Read-only.** No write-back. To change the value, edit the source note's
  frontmatter.
- **Raw scalar rendering.** v1 renders the literal frontmatter value as text
  (`42`, `2026-06-17`, `chaotic good`). No date/currency formatting yet.
- No anchors and no display aliases on property refs in v1.

### Rendering on miss

Unresolved note, or note resolves but key is absent → render with a distinct
**broken-ref** style, reusing the existing broken-wiki-link UX so mistakes
are visible (not silently blank, not raw text).

## 3. Architecture (Approach A)

Slots into three patterns that already exist; adds no new subsystem.

### 3.1 Canonical AST node

Add a distinct inline variant rather than overloading `WikiLink` (which is
fundamentally about navigation and feeds the links index):

```
Inline::PropertyRef { note: Option<String>, property: String }
```

`note: None` is the self-reference. This keeps the navigational link type and
its index honest, and lets search/export/plugins/Rust all see property refs
as their own thing.

### 3.2 Tokenizer branch (Rust + TS, parity)

The wiki-link tokenizer runs in both
[`crates/cubical-ast/src/wikilink.rs`](../../../crates/cubical-ast/src/wikilink.rs)
and [`ui/src/ast/wikilink.ts`](../../../ui/src/ast/wikilink.ts), kept in
lockstep by parity fixtures. Inside `[[ ]]`: if the target contains a dot,
branch to `PropertyRef` (split at first dot; no anchor parsing). Otherwise
the existing `WikiLink` path is unchanged. Add parity fixtures for
`[[Gandalf.age]]`, `[[.age]]`, and the dotted-filename non-link case.

### 3.3 Resolution (on-demand, never indexed)

Property values change on every edit; baking them into the libSQL index would
thrash — resolve at render time, the way the link/embed layers already do.

- **Self (`note: None`):** parse the current document's frontmatter
  ([`ui/src/ast/frontmatter.ts`](../../../ui/src/ast/frontmatter.ts)), look up
  the key, re-render on the normal AST tick. Trivial reactivity.
- **Cross-file:** resolve the note name via the existing wiki-link resolver
  ([`ui/src/editor/wikilinkResolver.ts`](../../../ui/src/editor/wikilinkResolver.ts)
  → `crates/cubical-core/src/vault/links.rs` `resolve_target`) to a path,
  then fetch + cache that file's frontmatter and **invalidate on its
  change events** following the embed pattern in
  [`ui/src/editor/embedResolver.ts`](../../../ui/src/editor/embedResolver.ts).
  A property ref is effectively a one-scalar embed — embeds already solve
  "pull from another file, stay fresh."

### 3.4 Rendering

A CodeMirror live-preview widget modeled on
[`ui/src/editor/dataview.ts`](../../../ui/src/editor/dataview.ts), with a pure
render helper analogous to
[`ui/src/dataview/dataviewRender.ts`](../../../ui/src/dataview/dataviewRender.ts).
The widget shows the resolved scalar read-only, broken-ref class on miss.

### 3.5 Toggle

Register as a core plugin like Dataview
([`ui/src/settings/corePlugins.ts`](../../../ui/src/settings/corePlugins.ts)),
default-on, toggleable. When off, refs render as inert literal text.

### 3.6 Dotted-filename UI guard

Note create/rename rejects a `.` in the name (before the `.md` extension),
and existing dotted notes get a flag/badge prompting a rename. The parser is
correct without this, but the linking story needs it so users don't author
unreachable notes. **Separable sub-deliverable** — can land in the same
branch or immediately after.

## 4. Why not the alternatives

| Approach | Verdict |
|---|---|
| **B — `property` field on `WikiLink`** | Fewer types, but muddies a navigation node + its index without saving the resolution/render work. More coupling, not less effort. |
| **C — frontend-only, no AST change** | Fastest, but the ref never enters the canonical AST → invisible to search/export/plugins/Rust, and breaks the Rust↔TS parity discipline. A shortcut paid for later. |

## 5. Dotted filenames — the trade

Dot-as-separator means a note named `2026.06.20.md` can't be `[[ ]]`-linked by
name. Cubical can't *prevent* such files existing (external tools, byte-for-byte
vault), so the rule is enforced only where Cubical can: the **UI blocks
creating new dotted note names and flags existing ones** (§3.6); the **linker
treats every dot as a property separator**. Dotted notes still open via tree
and search — they're just not plain-link targets. Accepted deliberately in
favor of an unambiguous, single-rule parser.

## 6. Scope boundaries

**v1 builds:** `[[note.prop]]` + `[[.prop]]`, read-only, raw scalar,
top-level keys, broken-ref on miss, core-plugin toggle, dotted-name UI guard.

**Deferred (additive later, not designed away):**

- Editable write-back into source frontmatter.
- Nested property paths (`[[a.b.c]]`).
- Type-aware formatting (dates/currency/enums) — leans on the
  [vault type registry](2026-06-20-typed-properties-vault-registry-design.md).
- Display aliases / anchors on property refs.
- Per-occurrence reactivity optimizations beyond the embed-cache pattern.

## 7. Testing

- **Parity fixtures** (Rust + TS) for the tokenizer: `[[Gandalf.age]]`,
  `[[.age]]`, `[[a.b.c]]`, dotted-filename non-link, malformed (`[[.]]`,
  `[[Gandalf.]]`).
- **Resolution unit tests:** self-ref hit/miss; cross-file hit; note-missing;
  key-missing; value coercion to display text.
- **Reactivity test:** edit a source note's frontmatter → dependent render
  updates (mirror the embed-resolver invalidation tests).
- **Render test:** widget output for resolved vs broken-ref.
- Gate: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs).
