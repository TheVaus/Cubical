> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Typed Properties via Inline YAML Comments — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm), implementation in progress on `feat/typed-properties`
**Scope:** UI (`ui/`) only. No Rust, no libSQL, no Dataview changes this session.
**Supersedes the "Typed Properties" item in** `docs/architecture/planned.md`.

This revision reflects the finalized taxonomy after operator review (enum
added; multiline / generic number / separate datetime / tags / "checkbox"
removed; currency carries a code; date carries a format incl. time).

---

## 1. Problem

The Properties panel infers a property's type from its value shape and
lets the user override it only transiently (resets on doc switch). There
are no subtypes (currency, date formats), no persistence, and no way to
constrain a value to a set. This feature makes a property's type **persist
with the file** as a portable inline YAML comment and adds a small, DB-like
type system.

## 2. Non-negotiables honored

- Plain `.md` files stay the source of truth — the type lives **inside the
  file** as a standard YAML comment; nothing in `.cubical/`.
- Frontmatter stays YAML, byte-for-byte portable. We add only trailing
  comments. Text values are quoted **only when bare YAML would misread
  them** (the `yaml` library default) — clean, ecosystem-portable files.
- No new dependency (eemeli's `yaml` preserves per-node comments).
- All of this is **frontend-only**, for consistent rendering.

## 3. The type system

A property's resolved type is a small record (a "column type", in DB
terms):

```ts
interface PropertyType {
  kind: CellKind;     // the discriminant
  format?: string;    // date only — a curated format token
  currency?: string;  // currency only — a lowercase code (usd/nis/eur)
  values?: string[];  // enum only — the allowed values, in order
}

type CellKind =
  | "string"           // text
  | "int"              // whole number
  | "float"            // decimal
  | "currency"         // a float rendered with a currency symbol
  | "boolean"          // true / false
  | "enum"             // one of a fixed set of values
  | "date"             // a date (or date+time), formatted
  | "list-of-strings"  // an array of strings (# items render as tag chips)
  | "raw";             // anything the UI can't model
```

There is **no** generic `number`, `multiline`, separate `datetime`,
`tags`, or `checkbox` kind.

## 4. Grammar — the inline comment

Trailing `# type:<token>` on the key's line. The marker is `type:`; the
rest of the comment (after `type:`, trimmed) is the token. The token may
contain spaces (date formats like `YYYY-MM-DD HH:MM`) and parentheses
(enum), so the parser captures everything to end-of-comment, not just
non-whitespace.

```yaml
---
name: Ann                  # type:text
count: 42                  # type:int
ratio: 0.8                 # type:float
price: 9.99                # type:float/currency/usd
alive: true                # type:boolean
status: alive              # type:enum(alive,dead)
flag: 1                    # type:enum(1,0)
due: 2026-06-17            # type:date:YYYY-MM-DD
meeting: 2026-06-17 14:30  # type:date:YYYY-MM-DD HH:MM
year: 2026                 # type:date:YYYY
topics:                    # type:list
  - "#draft"
  - research
---
```

| Kind | Token | Stored value |
| --- | --- | --- |
| string | `text` | string (quoted only if ambiguous) |
| int | `int` | integer |
| float | `float` | number |
| currency | `float/currency/<code>` | **bare float**; code → symbol only |
| boolean | `boolean` | `true` / `false` |
| enum | `enum(v1,v2,…)` | one listed value, verbatim |
| date | `date` or `date:<FORMAT>` | string in the format (`YYYY` → number) |
| list-of-strings | `list` | string array |

- **Marker is permissive only after `type:`** — a comment is a type hint
  only when the text after `type:` resolves to a known kind; otherwise it
  is an ordinary foreign comment (§7).
- **Comment placement:** scalar values carry the comment trailing the value
  (`price: 9.99 # …`); block-list values carry it on the key line
  (`topics: # …`), which re-parses as the value node's `commentBefore`.
- **Aliases accepted on parse** (never emitted): `string`→text.

### 4.1 Currency

`float/currency/<code>`, lowercase. Supported now: `usd` ($, ISO USD),
`nis` (₪, ISO ILS), `eur` (€, ISO EUR). Unknown code → falls back to a
plain float render (no crash). The value is always a bare float; the code
only selects the symbol/format (`Intl.NumberFormat`).

The **default currency** is a vault setting (`properties.default_currency`,
default `usd`). A currency matching the default is written **bare**
(`# type:float/currency`); a differing code is written inline
(`# type:float/currency/eur`). Effective code = inline → vault default →
`usd`. Omitting the default is safe here (unlike dates) because the value
is a format-agnostic number — changing the default only re-skins the
symbol, never breaks a stored value.

### 4.2 Enum

`enum(v1,v2,…)` — comma-separated allowed values (trimmed; no commas or
parens inside a value for v1). The stored value is one of them, written
verbatim: a value that looks numeric (`enum(1,0)`) is stored as a **number**,
otherwise as a **string**. Rendered as a `<select>`. Empty `enum()` is
valid (no values yet) and renders a values editor.

### 4.3 Date formats

Curated picklist; the value is stored **in the format**. The format is
**always written inline** (`# type:date:<FORMAT>`) — unlike currency, a
date's value is stored *in* its format, so a bare `# type:date` resolving
via a vault default would mis-read the value if the default ever changed.
Effective format = inline → ISO (a format-less date — inferred or a bare
`# type:date` — is ISO-shaped). The vault setting
`properties.date_format_default` seeds the **"Default" entry** at the top of
the Date menu (what a new date pick uses); it does not re-interpret existing
values.

| Token | Example | Widget | YAML value |
| --- | --- | --- | --- |
| `YYYY-MM-DD` (default) | `2026-06-17` | native date | string |
| `YYYY-MM-DD HH:MM` | `2026-06-17 14:30` | native datetime-local | string (space-separated) |
| `YYYY` | `2026` | number input | number |
| `YYYY-MM` | `2026-06` | text | string |
| `DD-MM-YYYY` | `17-06-2026` | text | string |
| `DD-MM-YY` | `17-06-26` | text | string |
| `MM/DD/YYYY` | `06/17/2026` | text | string |
| `DD/MM/YYYY` | `17/06/2026` | text | string |

- Each format has a regex, placeholder, widget, and parse/format rule (no
  date library). Adding a format is a one-row change.
- `datetime-local` uses a `T` separator on the wire; `DateCell` maps to/from
  the stored space separator for `YYYY-MM-DD HH:MM`.
- **Changing format** reformats best-effort (parse against all known formats
  to recover Y/M/D[/H/M], re-render). Widening that needs missing parts
  (`YYYY` → `YYYY-MM-DD`) blanks the value + flags lossy (no invented
  parts). Narrowing that drops time (`… HH:MM` → date) keeps the date but
  flags lossy.
- Part validation: month 1–12, day 1–31, so ambiguous shared-regex formats
  (`MM/DD/YYYY` vs `DD/MM/YYYY`) disambiguate (`17/06` can't be `MM/DD`).

### 4.4 List + tag chips

`list` is an array of strings. There is no `tags` type. Items whose stored
string **starts with `#`** render as accent-colored tag chips and, when a
tag-navigation handler is present, click to open that tag's page (the `#`
is stripped for the lookup); other items render as plain string chips and
click to edit.

**Special `tags` key:** because the ecosystem convention stores tags
without a `#` (`tags: [draft, wip]`), the `tags` property renders *every*
item as a tag chip even without a `#` — gated by the vault setting
`properties.tags_key_as_tags` (default **on**). The displayed chip shows a
leading `#` when the stored value lacks one (display only; the stored value
is unchanged). Only `tags` is special-cased — `aliases`/`cssclasses` are
not tags — but the implementation is a small key set, easy to extend.

## 5. Resolution

```
resolvedType(key) =
  (typedEnabled ? parseTypeComment(key) : undefined)
    ?? { kind: inferType(key, value) }
```

`inferType` (no comment present): boolean→`boolean`; number→`int` if it is a
whole number else `float`; ISO-date string→`date`; array→`list-of-strings`;
string→`string`; else `raw`. (Explicit-only kinds — `currency`, `enum`, and
non-default date formats — come only from a comment or a menu choice.)

When the `properties.typed_enabled` toggle is off, comment-based resolution
is skipped (pure inference), but comments are still preserved (§7, §8b.4).
Picking a type from the `▾` menu writes/updates the comment — that is what
makes it persist.

## 6. Parse / serialize

All in `ui/`, via the `yaml` Document API (deviation from the old §7.1: the
parser lives in `ui/src/properties/typeComments.ts`, not the `ast` layer).

- **Parse** — `parseTypeComments(yaml): Map<string, PropertyType>` reads each
  top-level pair's trailing `comment` (scalars) or value `commentBefore`
  (block lists), matches `^\s*type:(.+)$`, and maps the token to a
  `PropertyType` (incl. currency code, enum values, date format).
- **Serialize** — `serializeFrontmatter(entries, types?, dateDefault?)` builds
  a Document and sets each annotated key's node comment to ` type:<token>`
  via `typeToToken(type, dateDefault)`. Scalar → value node comment; block
  list → key node comment. Inferred-only / `raw` kinds are not emitted; a
  date whose format equals the default omits the param.
- **`hasUnmodelableYaml`** exempts comments (trailing or `commentBefore`)
  matching a known `type:` token; foreign comments, anchors, aliases, and
  document-level comments still force read-only.

## 7. Read-only guard

A note mixing our `type:` comments with foreign prose comments/anchors/
aliases stays read-only (we can only round-trip our own comments).

## 8. UI — `Properties.tsx` + cells

- **Cells:** `StringCell` (text), `NumberCell` (int via `integer` prop,
  float plain), `CurrencyCell` (currency code → symbol/format, stores bare
  number), `BooleanCell` (true/false), `EnumCell` (`<select>` over values +
  a values editor), `DateCell` (format-aware: native date / datetime-local /
  number / validated text), `StringListCell`/`ChipList` (per-item `#` tag
  chips), `RawCell`. **Deleted:** `MultilineCell`, `DateTimeCell`,
  `TagListCell` (folded into the above).
- **Nested type menu** (`▾`, shown only when typed properties are enabled):
  - Text · Integer · Boolean · Enum · List — commit immediately (Enum seeds
    `enum()` and reveals the values editor on the cell).
  - Float → Decimal / Currency (USD) / Currency (NIS) / Currency (EUR).
  - Date → one leaf per format (incl. `YYYY-MM-DD HH:MM`).
- **Persistence:** `changeType(key, type)` coerces the value to the new type
  — `convertDate` for dates, value-set coercion for enums, `coerceValue`
  otherwise — records the type in the annotation map, and reserializes
  (writing the comment). A lossy conversion shows the existing revert chip.
- **Enum values editor:** picking Enum (or the cell's edit affordance) opens
  a comma-separated text input; committing rewrites the comment
  (`onSetEnumValues`) and the cell becomes a `<select>`.
- Value/rename/add commits pass the current type map unchanged, so untyped
  keys never gain a comment (no spray) and existing comments are preserved.

## 8b. Settings + in-app docs

Settings ▸ Editor (matching the core-plugin precedent):

- **`properties.typed_enabled`** (boolean, default **on**). Nothing is
  written to a file until a type is explicitly chosen.
- **`properties.date_format_default`** (string, default `YYYY-MM-DD`) and
  **`properties.default_currency`** (string, default `usd`), shown as
  dropdowns (visible when typed properties are on) over the curated format
  tokens / currency codes.
- **`properties.tags_key_as_tags`** (boolean, default **on**), an on/off
  toggle for rendering the `tags` property as tag chips even without `#`
  (§4.4).
- All keys live in `.cubical/config.toml`; defaults applied in TS
  (`getSetting(...) ?? default`); no backend change.
- A help block documents every type's `# type:` syntax (a full reference),
  that it lives in the note and is portable, how to set a type, and that
  turning the feature off leaves comments intact.

### 8b.4 Behavior when OFF

Always-on regardless of the flag: the serializer preserves `# type:`
comments and `hasUnmodelableYaml` exempts them (no read-only regression, no
data loss). Gated by the flag: the type submenu, comment-based resolution
(off ⇒ pure inference), and writing new comments.

## 9. Out of scope (this session)

- Vault-wide registry of a property's kind (only the date **format** has a
  vault default).
- Dataview-driven / computed "dynamic" properties (a desired future
  follow-up; read-only properties sourced from a query — its own spec).
- Feeding types into libSQL or making Dataview type-aware.
- Currencies beyond usd/nis/eur; arbitrary date formats; a date library;
  enum values containing commas/parens.
- Rust / `cubical-ast` changes.

## 10. Testing (vitest, node, pure functions)

- **Grammar:** parse/emit each token incl. `float/currency/usd`,
  `enum(alive,dead)`, `enum(1,0)`, `date:YYYY-MM-DD HH:MM`; round-trip
  identity; block-list `commentBefore` placement; permissive spaces in the
  date format token.
- **Inference:** whole number→int, fractional→float, bool→boolean, ISO
  date→date, array→list, else text/raw.
- **Currency:** code→symbol/ISO mapping; bare-number storage; unknown code
  falls back.
- **Enum:** numeric-looking values stored as numbers; value-set parse/emit;
  empty `enum()`.
- **Date formats:** validate, parse, cross-format `convertDate` (incl.
  date↔datetime widening/narrowing lossiness), `YYYY` numeric storage,
  ambiguous MM/DD vs DD/MM disambiguation, `YYYY-MM-DD HH:MM` round-trip.
- **`hasUnmodelableYaml`:** allows known `type:` tokens (trailing + block);
  flags unknown tokens, foreign comments, anchors.
- **Coercions + lossy revert.**
- **Toggle off:** comments preserved, no read-only, menu hidden, no writes.

## 11. Gates

`npx tsc --noEmit`, `npx vitest run`, `npm run build`. Rust gates stay green
(no Rust changed): `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --all --check`.
