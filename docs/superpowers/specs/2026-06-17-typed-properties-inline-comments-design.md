# Typed Properties via Inline YAML Comments — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** UI (`ui/`) only. No Rust, no libSQL, no Dataview changes this session.
**Supersedes the "Typed Properties" item in** `docs/architecture/planned.md` (§ "Typed Properties (Obsidian-style)") — this is that feature going live, with one deliberate deviation: the type registry is **per-note inline**, not an application-level vault-wide registry.

---

## 1. Problem

The Properties panel (`ui/src/Properties.tsx`) already renders type-aware
editor cells, but a property's type is:

- **Inferred** from the YAML value shape on every AST tick
  (`ui/src/properties/inferType.ts`), and
- **Overridable** only transiently — the user's chosen type lives in a
  `createSignal` Map that **resets on every document switch**
  (`Properties.tsx` `overrides`). The choice is forgotten immediately and
  is never shared or persisted.

There are also **no subtypes**: no int-vs-float, no currency, no datetime.

This feature makes a property's type **persist with the file** and adds a
**type → subtype** taxonomy.

## 2. Non-negotiables honored

- Plain `.md` files stay the absolute source of truth. The type lives
  **inside the file** as a YAML comment — nothing in `.cubical/` to lose,
  no side-car to drift.
- Frontmatter stays **YAML, byte-for-byte portable**. We add only standard
  YAML trailing comments. Values keep their native YAML scalar types.
- No new dependency: the UI already uses eemeli's `yaml` package, whose
  `parseDocument` model preserves per-node comments. Today's code
  deliberately discards comments (`stringify(obj)` + `hasUnmodelableYaml`
  bailing on any comment); we stop discarding *our own* comments.

## 3. Decisions (locked in brainstorm)

1. **Scope of a type:** per-note inline. The comment in each note's
   frontmatter *is* the type. No vault-wide registry, no derived index.
   A property may in principle be typed differently in different notes —
   that is that note's truth.
2. **Taxonomy (type → subtype):**
   - `text` → plain, multiline
   - `number` → int, float, currency (**USD only** to start)
   - `checkbox`
   - `date` → date, datetime
   - `list` → list (plain string list), tags
3. **Storage:** inline trailing YAML comment per top-level key.
4. **Backend untouched:** the libSQL `frontmatter` table, search index,
   and Dataview are unchanged. Dataview comparisons stay lexical. Typed
   queries are a possible follow-up session.
5. **Menu UI:** nested type → subtype submenu.
6. **Currency value:** stored as a **bare number** (`price: 9.99`); the
   `$` symbol and formatting are display-only. Currency-ness lives
   entirely in the type comment.
7. **Date formats:** the `date` type carries an optional **format** (a
   curated picklist — §4b). The value is stored **in that format**
   verbatim. The default format is a vault setting
   (`properties.date_format_default`, default `YYYY-MM-DD`); a property
   using the default writes a bare `# type:date`, and only a *non-default*
   format is written inline as `# type:date:<FORMAT>`. Effective format =
   inline param → vault default → `YYYY-MM-DD`.

## 4. Storage format — the comment grammar

Each top-level property carries its type as a **trailing comment** on the
key line.

```yaml
---
title: Quarterly Report        # type:text
notes: |                       # type:text/multiline
  long body…
price: 9.99                    # type:number/currency
count: 42                      # type:number/int
ratio: 0.8                     # type:number/float
done: true                     # type:checkbox
due: 2026-06-17                # type:date
start: 2026-06-17T14:30        # type:datetime
people:                        # type:list
  - Ann
tags: [draft]                  # type:tags
---
```

**Grammar:** `type:<type>[/<subtype>]`

| Comment token            | Leaf CellKind   | Cell                         |
| ------------------------ | --------------- | ---------------------------- |
| `text`                   | `text`          | `StringCell`                 |
| `text/multiline`         | `multiline`     | `<textarea>` cell            |
| `number/int`             | `int`           | `NumberCell` (integer mode)  |
| `number/float`           | `float`         | `NumberCell` (float mode)    |
| `number/currency`        | `currency`      | `CurrencyCell` (`$`, USD)    |
| `checkbox`               | `boolean`       | `BooleanCell`                |
| `date`                   | `date`          | `DateCell`                   |
| `datetime`               | `datetime`      | `DateTimeCell`               |
| `list`                   | `list-of-strings` | `StringListCell`           |
| `tags`                   | `list-of-tags`  | `TagListCell`                |

- Marker `type:` is short and readable, and plain text any tool reads.
  Because `type:` is a common word, a comment is only treated as a type
  hint when the text after `type:` matches a **known grammar token**
  (§5 / the alias list below); anything else is left as an ordinary
  foreign comment (§7).
- **USD-only currency** is encoded as `number/currency` now. The parser
  must tolerate (ignore, falling back to `currency`/USD) a future
  `number/currency:EUR` form so a later currency expansion does not
  invalidate files — but only USD is produced this session.
- **Comment placement:** for scalar values the comment sits after the
  value (`price: 9.99 # …`); for block-list values it sits on the key
  line (`people: # …`). Both round-trip in the `yaml` Document model.
- **Flat vs nested tokens:** although the *menu* (§8) groups `datetime`
  under Date and `tags`/`list` under List, the on-disk tokens are written
  flat (`datetime`, `tags`, `list`) for brevity. The parser also **accepts**
  the nested aliases `date/datetime`, `list/tags`, `list/list` so
  hand-written files round-trip, but only the flat form is emitted.
- **Date format param** (§4b): a non-default date format is encoded as
  `type:date:<FORMAT>` (e.g. `type:date:DD-MM-YY`). A `date` using the
  vault default writes a bare `type:date`.
- **Unknown / malformed tokens** are ignored — the property falls back to
  inference (§6), and the foreign comment is then treated like any other
  foreign comment (§7).

## 4b. Date formats

The `date` type carries an optional **format** drawn from a curated
picklist. The value is written to the file **in that format**.

| Format token   | Example value | Editor                      | YAML value type |
| -------------- | ------------- | --------------------------- | --------------- |
| `YYYY-MM-DD`   | `2026-06-17`  | native `<input type=date>`  | string          |
| `YYYY`         | `2026`        | number input (year)         | number          |
| `YYYY-MM`      | `2026-06`     | validated text              | string          |
| `DD-MM-YYYY`   | `17-06-2026`  | validated text              | string          |
| `DD-MM-YY`     | `17-06-26`    | validated text              | string          |
| `MM/DD/YYYY`   | `06/17/2026`  | validated text              | string          |
| `DD/MM/YYYY`   | `17/06/2026`  | validated text              | string          |

- **Curated, extensible:** each format has a known validation regex,
  placeholder, and parse/format rule (no date library). The grammar stores
  the token **verbatim**, so adding a format later is a one-line table
  change. An **unknown** format token falls back to the vault default
  (and is otherwise treated like any foreign comment when serializing —
  see §7.3).
- **Default lives in settings:** `properties.date_format_default`
  (string, default `YYYY-MM-DD`; §8b). When a property's format equals the
  effective default, **no param is written** (bare `# type:date`); only a
  differing format is written inline. This keeps files clean and lets the
  vault default re-skin all default-format dates at once.
- **`YYYY` stores a number:** a year-only date is a bare YAML number
  (`year: 2026`), which is the natural, portable representation; all other
  formats are strings.
- **Editing:** `YYYY-MM-DD` uses the native date picker (its value format
  already matches). Every other format uses a text input that shows the
  format as a placeholder and validates against the format's regex on
  commit (rejects → reverts to the last valid value, like `NumberCell`).
- **Changing the format** (in the Date submenu, §8) reformats the current
  value best-effort: the value is parsed against the known formats to
  recover year/month/day, then re-rendered in the target format. If the
  target needs a month/day the source lacks (e.g. `YYYY` → `YYYY-MM-DD`),
  the result is blanked and the lossy-revert chip appears (§8) — no parts
  are invented.

## 5. Leaf CellKind union

Extend the existing `CellKind` union (`inferType.ts`). Current members
(`string`, `number`, `boolean`, `date`, `list-of-strings`, `list-of-tags`,
`raw`) are kept and extended with the new leaves:

```
type CellKind =
  | "string"          // text                (inferred or text/plain)
  | "multiline"       // text/multiline      (NEW, explicit only)
  | "number"          // generic number      (inferred only — kept)
  | "int"             // number/int          (NEW, explicit only)
  | "float"           // number/float        (NEW, explicit only)
  | "currency"        // number/currency     (NEW, explicit only)
  | "boolean"         // checkbox
  | "date"            // date
  | "datetime"        // date/datetime       (NEW, explicit only)
  | "list-of-strings" // list
  | "list-of-tags"    // tags
  | "raw";
```

`inferType` still returns only the *inferred* kinds (`string`, `number`,
`boolean`, `date`, `list-of-strings`, `list-of-tags`, `raw`). The
explicit-only leaves (`multiline`, `int`, `float`, `currency`, `datetime`)
arrive solely from a type comment or a menu choice.

A small bidirectional map `CellKind ⇄ comment token` (e.g.
`kindToToken` / `tokenToKind`) is the single source of grammar truth,
shared by parse and serialize.

### 5.1 PropertyType — kind plus optional format

Because `date` carries a format (§4b), a resolved property type is not a
bare `CellKind` but a small record:

```
interface PropertyType {
  kind: CellKind;
  /** Date format token; only meaningful when kind is "date". */
  format?: string;
}
```

`parseTypeComments`, the annotation map, and `serializeFrontmatter` all
key on `PropertyType`. For every kind except `date`, `format` is absent.

## 6. Resolution: comment wins, else infer

```
resolvedType(key) =
  (typedEnabled ? parseTypeComment(key) : undefined)
    ?? { kind: inferType(key, value) }

// effective date format, when kind === "date":
effectiveFormat(key) =
  resolvedType(key).format ?? vaultDefaultFormat ?? "YYYY-MM-DD"
```

(When the `properties.typed_enabled` toggle is off, comment-based
resolution is skipped — see §8b.4 — but comments are still preserved.)

- Existing vaults with no type comments keep working unchanged via today's
  inference.
- A type becomes "sticky" only once written.
- Picking a type from the menu **writes/updates the comment** — that is
  what makes it persist. This **replaces** today's transient `overrides`
  Map: the persisted comment is the override store.

## 7. Parse / serialize changes (the core work)

All in `ui/`:

### 7.1 Parse — `ui/src/ast/frontmatter.ts`

New pure function `parseTypeComments(yaml: string): Map<string, PropertyType>`
(§5.1):

- Use `parseDocument` (already imported in `serializeFrontmatter.ts`; bring
  it into the parse module or a shared helper).
- For each **top-level** pair, read the trailing comment from the key node
  and/or value node, match `^\s*type:<token>`, map via `tokenToKind`.
- Tolerate the future `currency:XXX` form (strip the `:XXX`, treat as
  currency).
- **Date format param:** `date:<FORMAT>` → `{ kind: "date", format: FORMAT }`
  when `FORMAT` is a known format token; bare `date` → `{ kind: "date" }`.
  An unknown format token → `{ kind: "date" }` (falls back to the vault
  default).
- Malformed / unknown *kind* tokens → omit the key from the map (falls back
  to inference).

Value parsing (`parseFrontmatterYaml`) is unchanged.

### 7.2 Serialize — `ui/src/properties/serializeFrontmatter.ts`

`serializeFrontmatter` gains a second argument: the type map (or accepts
entries already carrying their kind). It rebuilds the block via the
**Document API** instead of `stringify(obj)`:

- Build a `YAMLMap`/Document from entries.
- For each key with a resolved `PropertyType` that should be persisted, set
  the appropriate node `.comment` to `' type:<token>'` (leading space
  per the `yaml` package's convention). For a `date` with a `format`, the
  token is `date:<FORMAT>`; without one it is bare `date`.
  - Scalar value → comment on the **value** node (`key: val # …`).
  - Block list value → comment on the **key** node (`key: # …`).
- Serialize `---\n${String(doc)}---\n`.

**Which keys get a comment written?** Only keys whose type was explicitly
chosen by the user (i.e. present in the persisted type set). Inferred-only
keys are *not* annotated, to avoid spraying comments across every existing
property on first edit. (Open detail for the plan: whether to also write a
comment when the user edits a value whose kind was inferred — default: no,
only on explicit type choice.)

### 7.3 `hasUnmodelableYaml` relaxation

- Comments matching `^\s*type:<known-token>` **do not** force read-only.
- Any other comment (including `type:` followed by an unknown token),
  anchors, aliases, document-level comments still force read-only
  (unchanged).
- A note mixing our type comments **and** foreign prose comments stays
  read-only — accepted edge case (the foreign comment can't be preserved).

## 8. UI changes — `ui/src/Properties.tsx` + cells

- **New cells:**
  - `CurrencyCell` — number input with a `$` adornment; reads/writes a bare
    number; formats display with thousands separators + 2 decimals; USD.
  - `DateTimeCell` — `datetime-local` input; stores ISO `YYYY-MM-DDTHH:mm`
    string (matches today's date-as-string handling; the default `yaml`
    schema does not auto-parse timestamps, so it stays a string).
  - `DateCell` becomes **format-aware** (§4b): a `format` prop selects the
    native `<input type=date>` for `YYYY-MM-DD`, a number input for `YYYY`,
    or a validated text input (placeholder = the format) for the rest.
  - Multiline → `<textarea>` rendering (can be a mode of `StringCell` or a
    sibling `MultilineCell`).
  - `NumberCell` gains int-vs-float behavior (int rejects/rounds decimals;
    float allows them).
- **Type menu → nested submenu:** top level = type families
  (Text, Number, Checkbox, Date, List); selecting a family with subtypes
  opens a submenu. Number → Int / Float / Currency (USD); Text → Plain /
  Multiline; List → List / Tags. **Date** → Date & time, then one leaf per
  date format (`YYYY-MM-DD` (default), `YYYY`, `YYYY-MM`, `DD-MM-YYYY`,
  `DD-MM-YY`, `MM/DD/YYYY`, `DD/MM/YYYY`); each format leaf sets
  `{ kind: "date", format }`. Families with a single leaf commit
  immediately. Keyboard nav + focus-out close behavior must match the
  existing menu.
- **Persistence wiring:** `changeType(key, type)` (where `type` is a
  `PropertyType`) now (a) records the type in the persisted annotation map
  and (b) reserializes so the comment is written, rather than mutating the
  transient `overrides` signal. `resolvedType` reads from the parsed comment
  map first. The default date format is *not* written inline (bare
  `# type:date`); a non-default format is.
- **`coerce.ts`** extended for new conversions (e.g. string↔number for
  currency, date↔datetime, int↔float, scalar↔multiline). Lossy-revert
  behavior (the existing `lossy` warning chip) is preserved.

## 8b. Settings toggle + in-app docs

The feature is gated by a vault setting and documented inside the Settings
modal, matching the core-plugin precedent
(`plugins.dataview_enabled`, `ui/src/settings/corePlugins.ts`).

### 8b.1 Setting keys

Two new keys on the `Setting` union in `ui/src/api/ipc.ts`. No backend
change: the settings map in `cubical-core` stores arbitrary keys, and
defaults are applied in TS (`getSetting(...) ?? default`), exactly as
`corePluginEnabled` does. Both are stored in `.cubical/config.toml`
(durable, portable) — not `ui.*` workspace keys.

- **`properties.typed_enabled`** (boolean) — **default on** (`true`). Safe
  because nothing is written to a file until the user explicitly picks a
  type — no comment spray on existing notes.
- **`properties.date_format_default`** (string) — **default `YYYY-MM-DD`**.
  The vault-wide default date format (§4b). Must be one of the curated
  format tokens; an unrecognized stored value falls back to `YYYY-MM-DD`.

### 8b.2 Placement — Settings ▸ Editor

Typed properties is an editor feature, not a plugin, so the toggle lives in
the **Editor** tab (alongside the raw-source default), not under Plugins.
A labelled switch bound to `properties.typed_enabled`, loaded/hydrated on
vault open the same way `corePlugins` state is. Directly below it, a
**Default date format** dropdown (visible/enabled only when typed
properties are on) bound to `properties.date_format_default`, listing the
curated format tokens (§4b).

### 8b.3 In-app docs

Below the toggle, render a short help block so the user can see how it
works without leaving the app. Copy covers:

- What it does: each property can be given a type/subtype; the Properties
  panel then shows the right editor (e.g. a `$` currency field, a
  date-and-time picker).
- Where the type is stored: as a plain YAML comment **inside the note**
  (`price: 9.99   # type:number/currency`), so it travels with the file and
  is readable by any tool — nothing is stored outside the vault.
- How to set it: pick a type from the `▾` menu on a property row; the
  comment is written automatically.
- Dates: the **Default date format** applies to every date; pick a
  different format per-property from the Date submenu, and that choice is
  written inline (`# type:date:DD-MM-YY`).
- That turning the feature off leaves existing `# type:` comments intact.

The copy is plain Solid markup (no new dependency). A single source string
table keeps it maintainable.

### 8b.4 Behavior when the toggle is OFF

To make toggling off non-destructive and non-surprising:

- **Always on, regardless of the flag:** the serializer *preserves* any
  `# type:` comments it encounters (pass-through), and `hasUnmodelableYaml`
  still exempts `type:<known-token>` comments — so turning the feature off
  never strips comments and never forces a panel into read-only.
- **Gated by the flag (off ⇒ disabled):** the nested subtype submenu,
  comment-based type resolution (off ⇒ pure inference per §6, so a currency
  field renders as a plain number), and *writing* new type comments.

## 9. Out of scope (this session)

- Vault-wide registry / consistency across notes.
- Feeding types into libSQL or making Dataview type-aware.
- Currencies other than USD.
- Vault-wide default for a property's *kind* (no kind registry; the only
  vault-wide default is the date **format**, §4b).
- Date formats beyond the curated picklist; arbitrary format strings; a
  date library; locale-aware month names.
- Rust / `cubical-ast` changes — the Rust frontmatter parser keeps
  ignoring comments; it never needed them and search/index are untouched.

## 10. Testing (vitest only)

- **Grammar round-trip:** parse each token → kind; serialize kind → exact
  comment; full parse→serialize→parse identity, including block-list
  comment placement and flow-list placement.
- **Comment wins over inference**; missing comment falls back to inference.
- **Future-currency tolerance:** `number/currency:EUR` parses as currency
  (USD cell) without error.
- **Currency:** stores bare number, displays `$`, edit strips formatting.
- **Datetime:** ISO string round-trips; not coerced to a Date object.
- **Date formats:** each curated format validates correct/incorrect values;
  parse-then-format round-trips; cross-format conversion recovers y/m/d and
  blanks (lossy) when widening (`YYYY` → `YYYY-MM-DD`); `YYYY` stores a
  number. Grammar: `type:date:DD-MM-YY` parses to `{kind:"date",
  format:"DD-MM-YY"}`; an unknown format → `{kind:"date"}`. Serialize omits
  the param when the format equals the effective default and writes it
  otherwise. `effectiveFormat` falls back inline → vault default → ISO.
- **`hasUnmodelableYaml`:** allows `type:<known-token>` comments; still
  flags `type:` with an unknown token, foreign comments, anchors, aliases,
  and mixed.
- **Coercions:** each new lossy/non-lossy conversion; revert chip restores
  the pre-coercion value.
- **No-comment legacy vault:** a frontmatter block with zero type comments
  is unchanged byte-for-byte after an unrelated value edit (no comment
  spray).
- **Toggle off:** comment-based resolution is skipped (currency renders as
  plain number) but existing `# type:` comments are preserved through an
  edit and the panel does not go read-only; the subtype submenu is hidden
  and no comments are written.
- **Toggle default:** absent setting resolves to enabled (`true`).

## 11. Gates

`npx tsc --noEmit`, `npx vitest run`, `npm run build`. (Rust gates
unaffected but should stay green: `cargo test --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all
--check`.)
