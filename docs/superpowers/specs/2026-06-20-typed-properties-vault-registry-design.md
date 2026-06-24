# Typed Properties via a Vault Type Registry — Future-Work Design

**Date:** 2026-06-20
**Status:** Deferred / intended replacement. Not scheduled. Captured so the
decision isn't lost.
**Relationship:** Supersedes-in-waiting for
[`2026-06-17-typed-properties-inline-comments-design.md`](2026-06-17-typed-properties-inline-comments-design.md).
The inline-comment feature shipped but is **defaulted off**
(`properties.typed_enabled` absent → false, [`ui/src/App.tsx`](../../../ui/src/App.tsx))
pending this replacement.

---

## 1. Why replace the inline approach

Inline `# type:` comments store a property's type as a trailing YAML
comment in the `.md` file (`price: 9.99 # type:float/currency/usd`). It
works and it's portable, but it conflicts with the project's own
non-negotiables:

- **"The vault is the user's vault, byte-for-byte."** A `# type:` comment is
  app metadata living in the canonical source of truth — the same category
  of thing deliberately banned for file-identity UUIDs before L7.
- **"Everything else is *derived* state, rebuildable from the markdown."** A
  type annotation is exactly derived/UI state, yet inline puts it in the
  non-derived layer.
- **Channel overload.** The type annotation and a user's own YAML comment
  fight for the same syntactic slot. The 2026-06-20 session existed entirely
  to reconcile that collision (preserve foreign comments through edits); the
  "edit a value, lose a trailing comment on it" edge is a direct symptom.
- **Conceptual mismatch.** A type is usually a property of a *field across
  the vault* (`price` is always currency), not of one value in one file.
  Inline forces the type to be repeated per value, which drifts.

The two things inline does better are real but soft: a type travels *inside*
a single file if you copy that note elsewhere, and the type is visible right
next to the value. Both are recoverable — types are reconstructable UI sugar,
and in-context visibility is a settings-panel problem.

## 2. The registry design

Types live in the `.cubical/` config layer (alongside the existing portable
`config.toml`), keyed by **property name**, applied vault-wide:

```toml
# .cubical/properties.toml
[types]
price  = "currency/usd"
budget = "currency/eur"
status = "enum(alive,dead)"
count  = "int"
tags   = "list"
due    = "date"

[display]          # display-only; storage stays canonical
due    = "MMM D, YYYY"
```

The markdown stays pristine — no app metadata:

```markdown
---
price: 9.99
status: alive
due: 2026-06-17
---
```

The Properties panel resolves `price`'s type from the registry, not from a
comment in the note. Setting a type in the UI writes to
`.cubical/properties.toml`, never to the `.md`.

### 2.1 Dates: storage format ≠ display format

The one thing genuinely per-value about inline was the **date format** — the
stored string can't be parsed without knowing its format. The registry
dissolves this:

- Store dates **ISO-canonical in the markdown** (`2026-06-17`) — always
  sortable, unambiguous, tool-agnostic.
- Keep the **display format** in the registry (`[display]`).
- The user sees `Jun 17, 2026`; the file holds `2026-06-17`. Storage format
  vs display format, the way a database works.

This removes the last reason a type needs to live next to the value.

### 2.2 Granularity

v1 of the registry: **one type per property name, vault-wide.** No
per-folder or per-file override. Two notes that use `date` to mean different
things is the only collision, and it's rare; per-folder scoping can be added
later if real vaults need it (YAGNI now). Vault-wide uniformity is mostly a
*consistency feature* for a PKM, not a limitation.

## 3. Head-to-head

| | Inline `# type:` comments (current, off) | Vault registry (intended) |
|---|---|---|
| Markdown purity | app metadata in source of truth | `.md` untouched |
| Aligns with non-negotiables | contradicts byte-for-byte + derived-state | types ARE derived state, in the derived layer |
| Comment collision | the whole 2026-06-20 session | gone — different channel |
| Type as a vault concept | repeated per value, drifts | declared once per field |
| Single-file portability | travels inside the file | stays behind if you copy one note out |
| Visible next to value | self-documenting | needs a settings/registry view |
| Survives foreign YAML tools | comments can be stripped/reflowed | app owns its own config file |
| Mixed formats, same key | per-value | one type per key name (a consistency gain) |

## 4. Migration path (inline → registry)

When this is built:

1. **Reader:** parse `.cubical/properties.toml` into the same
   `Map<string, PropertyType>` the panel already consumes
   (`propertiesLogic.ts → resolveType`). The `PropertyType` record and
   `CellKind` taxonomy carry over unchanged.
2. **Writer:** the panel's type-set actions write to the registry file
   instead of stamping a comment via `serializeFrontmatter`'s `types` arg.
3. **Date normalization:** on type-assign-as-date, rewrite the stored value
   to ISO; move the chosen format into `[display]`.
4. **One-time import:** offer to read existing inline `# type:` comments out
   of a vault's notes into the registry, then strip the comments from the
   `.md` files (explicit, user-confirmed — it's an edit to their source).
   `parseTypeComments` already extracts them.
5. **Retire** the inline read/write paths (`typeComments.ts` token
   read/write, the `types` arg of `serializeFrontmatter`). Delete, don't
   gate.

### What already survives the migration (do NOT rip out)

- **`serializeFrontmatter`'s in-place edit path** (reuse parsed nodes,
  preserve foreign comments/blank lines). This is the correct commit
  mechanism regardless of where types live — it's why editing properties no
  longer destroys a user's comments. Keep it.
- **`hasUnmodelableYaml`** flagging only anchors/aliases. Still correct.
- The `PropertyType` taxonomy, the cells, `coerce`, `convertDate`,
  `dateFormats`. All storage-agnostic.

Only the *type-storage channel* changes (comments → registry file). The
panel, the cells, and the serializer are untouched.

## 5. Decision & trigger

- **Now:** inline is implemented but **defaulted off**, so no app metadata
  lands in real `.md` files. As-if-absent for new vaults.
- **Trigger to build this:** before typed properties is promoted to a
  default-on feature, or before any further feature (sort/query/Dataview)
  takes a hard dependency on type storage. Whichever comes first — do not
  let more code pile onto the inline channel.
- **Architecture gate:** this changes where type state lives, so it's an
  architecture-level decision. Promote the live version into
  `docs/architecture/planned.md` §14 (or `document-model.md`) and write the
  implementation plan before code.
