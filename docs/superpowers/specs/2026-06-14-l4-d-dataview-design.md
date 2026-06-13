# L4-D — Dataview-style libSQL queries (design)

> Final L4 session. After this lands and the L4 layer-close smoke is run,
> tag `l4`. Spec source: `docs/layer-4-spec.md` §1.6/§2(D)/§3.2/§6;
> kickoff `docs/superpowers/2026-06-08-l4d-kickoff.md`.

## 1. Goal

A typed-frontmatter projection that complements Tantivy full-text. Where
search answers "which notes match these words?", this answers "list every
project with `status: in-progress` sorted by `due_date`." The user writes
a query in a fenced ```` ```query ```` block in `.md` source; the editor
detects it, evaluates it against libSQL, and renders a list / table /
count in place.

Plain `.md` stays the source of truth — the query block is ordinary
markdown text, byte-for-byte preserved. The rendered result is derived
state, never written back into the file.

## 2. Decisions (from brainstorming, 2026-06-14)

1. **Syntax — a minimal custom DSL wearing DQL-flavored keywords.** Not a
   Dataview-compat layer. Obsidian's DQL confuses users precisely because
   it shares SQL keywords with different semantics, and a partial-DQL
   invites `FLATTEN` / `GROUP BY` / `::` inline-field expectations we will
   not meet. We own a small grammar with a hand-written parser, honest
   scope, and our own error messages. Keyword surface mirrors DQL
   (`LIST`/`TABLE`/`COUNT`, `FROM`, `WHERE`, `SORT`) so muscle memory
   carries, but it is documented as a focused subset.
2. **New crate `cubical-query`**, depending on `cubical-index`. A query
   *language* (AST + parser + planner) is a distinct concern from
   "schema + queries"; isolating it keeps `cubical-index` focused, lets
   parser tests run with no DB, and matches the repo's small-focused-unit
   ethos. Auto-included via the existing `members = ["crates/*"]`.
3. **Render path mirrors the L3 embed widget.** A CodeMirror live-preview
   block widget detects the fence; cursor outside → rendered widget,
   cursor inside → raw source (same behavior embeds already have). The
   widget host is thin and delegates to a pure, jsdom-tested
   `dataviewRender.ts`, exactly like `embedRender.ts`. Async resolve like
   `embedResolver` ("Loading…" → fill); re-eval on the existing
   `searchRefreshTick` signal (coalesced).
4. **One IPC command** `dataview_query`, vault-id-keyed per the
   multi-vault contract (as with L4-A's four commands). The fence source
   already encodes which of list/table/count is wanted, so the frontend
   needs no variant. No streaming — frontmatter projections are small.
5. **Scope — Lean tier** (§4). `=, !=, <, <=, >, >=` on scalar
   frontmatter, `AND` only, single `SORT` key, `FROM` tag or folder.
   Deferred: `OR`/parens, `contains`, `GROUP`/`FLATTEN`, typed dates.

The fence info-string is **`query`**, deliberately not `dataview`, to
avoid signaling full Dataview compatibility.

## 3. Grammar

One logical query per fenced block. Keywords are case-insensitive;
whitespace-insensitive between clauses. Clause order is fixed:

```
<command> [FROM <source>] [WHERE <cond> {AND <cond>}] [SORT <key> [ASC|DESC]]
```

- **command**
  - `LIST` — one row per matching file (a note link).
  - `TABLE <field> {, <field>}` — a column per named frontmatter key,
    plus an implicit leading "file" column (the note link).
  - `COUNT` — the number of matching files.
- **source** (`FROM`, optional — absent means "all files")
  - `#tag` — files carrying that tag (prefix match, reusing the `tags`
    table semantics, so `#project` also matches `#project/active`).
  - `"folder/path"` — files whose path is under that folder
    (`path LIKE 'folder/path/%'`). Quoted; trailing slash optional.
- **cond** := `<frontmatter_key> <op> <literal>`
  - **op** ∈ `=`, `!=`, `<`, `<=`, `>`, `>=`.
  - **literal** is a double-quoted string, a number (int or float), or a
    bare `true` / `false`.
  - Multiple conds joined by `AND` only (left to right, no precedence,
    no parentheses).
- **key** (`SORT`, optional) — a frontmatter key, optional `ASC`
  (default) / `DESC`.

### Examples

```query
TABLE status, due_date FROM #project WHERE status = "in-progress" SORT due_date ASC
```
```query
LIST FROM "areas/health" WHERE priority >= 2
```
```query
COUNT WHERE done = true
```

Anything that does not parse renders as a ⚠ error widget carrying a
specific message (e.g. "expected a frontmatter key after WHERE") — not a
silent empty result. This is a deliberate improvement over Dataview's
most-reported failure mode (queries that silently return nothing).

## 4. Crate `cubical-query`

No Tauri deps; buildable/testable standalone. Three modules behind a thin
`lib.rs` surface.

### 4.1 `parser.rs` — text → AST

Hand-written recursive descent (tokenize then parse; small enough to be a
single file). Produces:

```rust
pub enum Command { List, Table(Vec<String>), Count }
pub enum Source { Tag(String), Folder(String) }          // None = all files
pub enum Op { Eq, Ne, Lt, Le, Gt, Ge }
pub enum Value { Str(String), Num(f64), Bool(bool) }
pub struct Cond { pub key: String, pub op: Op, pub value: Value }
pub enum SortDir { Asc, Desc }
pub struct Sort { pub key: String, pub dir: SortDir }

pub struct Query {
    pub command: Command,
    pub source: Option<Source>,
    pub conds: Vec<Cond>,            // implicitly AND-joined
    pub sort: Option<Sort>,
}

pub fn parse(src: &str) -> Result<Query, ParseError>;
```

`ParseError` carries a human message (and ideally a column) for the ⚠
widget. Unit-tested with no DB: valid queries of each shape, every
operator, each literal type, and the error cases (missing key, bad op,
unterminated string, trailing junk, unknown command).

### 4.2 `plan.rs` — AST → parameterized SQL

Pure function `Query → (String, Vec<SqlParam>)`. No DB; tested by
asserting the emitted SQL + params.

**The JSON-value rule.** `frontmatter.value` is JSON-encoded TEXT
(migration `002_frontmatter.sql`): a string is stored as `"in-progress"`,
a number as `3`, a bool as `true`. Every comparison normalizes through
`json_extract(value, '$')`, which unwraps to the native SQLite scalar
(string unquoted, number as number, bool as 0/1), compared against the
literal bound as a typed parameter:

- `status = "in-progress"`  →  `json_extract(fm.value,'$') = ?`  (param: text)
- `priority >= 3`           →  `json_extract(fm.value,'$') >= ?` (param: real)
- `done = true`             →  `json_extract(fm.value,'$') = ?`  (param: 1)

Because ISO-8601 dates sort lexically, `due_date < "2026-07-01"` works
with the string path and **no typed-date machinery** — this quietly
covers the §7 "date-range syntax if demanded" item.

Shape of the generated SQL:

- Base: `SELECT files.path FROM files`.
- Each `WHERE` cond → `JOIN frontmatter fmN ON fmN.file_path = files.path
  AND fmN.key = ?` then the normalized comparison in the `WHERE`.
- `FROM #tag` → join the tag relation (prefix match, mirroring
  `files_for_tag_prefix`). `FROM "folder/"` → `files.path LIKE ?`.
- `TABLE col` → `LEFT JOIN frontmatter` per column selecting
  `json_extract(value,'$')` (LEFT so a missing key yields an empty cell,
  not a dropped row).
- `SORT key` → `ORDER BY json_extract(...)` via a LEFT JOIN on the sort
  key; direction from `SortDir`. Files lacking the key sort last.
- `COUNT` → `SELECT COUNT(*)` over the same filtered set.

All literals and keys are bound parameters — never string-interpolated —
so a query block cannot inject SQL.

### 4.3 `exec.rs` — plan → result

`pub fn run(conn: &IndexConn, q: &Query) -> Result<QueryResult, QueryError>`
plans, executes against the passed-in connection, and shapes rows:

```rust
pub enum QueryResult {
    List(Vec<NoteRef>),                       // path + display title
    Table { columns: Vec<String>, rows: Vec<Row> }, // Row: NoteRef + cells
    Count(usize),
}
```

`NoteRef` carries the path and a display title (filename stem — no `# H1`
injection, per the non-negotiables). Tested against an in-memory
`cubical-index` seeded with files + frontmatter + tags covering each
command, the operators, tag vs folder sources, sort direction, and the
missing-key (empty cell / sort-last) cases.

## 5. IPC

One Tauri command in `cubical-app`, registered alongside L4-A's four:

```
dataview_query { vault_id, source: String } -> DataviewResult
```

- Resolve the vault's `IndexConn`, `cubical_query::parse(source)` then
  `run(...)`. Map both `ParseError` and `QueryError` into the
  `DataviewResult::Error { message }` variant so the renderer always gets
  a structured answer (no thrown IPC error for a bad query).
- Wire type `DataviewResult` = serde tag of `list` / `table` / `count` /
  `error`. TS wrapper + shape-smoke test in `ui/src/api`
  (mirrors `ui/src/api/search.test.ts`).

No new migration — the `frontmatter`, `tags`, `files` tables already
exist and are maintained by the L1/L3 refreshers.

## 6. Frontend

```
ui/src/dataview/
├── dataviewRender.ts        # pure: DataviewResult -> DocumentFragment
└── dataviewRender.test.ts   # jsdom unit tests
```

- **Detection + widget.** Extend the editor's live-preview decoration
  pass (the layer embeds use) to recognize a fenced block with
  info-string `query`. Outside the block → a block widget; inside → raw
  source. The widget host is thin: it owns lifecycle + the async fetch
  and calls `dataviewRender` to build the DOM — exactly the
  `embed.ts` / `embedRender.ts` split.
- **Async + cache.** Reuse the `embedResolver` shape: show a "Loading…"
  placeholder, fire `dataview_query`, fill on resolve; an `error` result
  renders the ⚠ placeholder with the message. Cache keyed on the block
  source string; invalidate on `searchRefreshTick` (coalesced) so edits
  elsewhere in the vault refresh the view.
- **Rendering.** `LIST` → a `<ul>` of clickable note links (reuse the
  wiki-link click/resolve path so navigation matches the rest of the
  editor). `TABLE` → a `<table>`; first column is the note link, each
  cell the extracted scalar as text; empty cell for a missing key.
  `COUNT` → a single number. No markdown rendering inside cells (plain
  text, consistent with `embedRender`'s deliberate non-parsing).

## 7. Testing & contracts

- `cubical-query`: parser, plan, and exec unit-tested as pure modules
  (no Tauri, no app harness) — the standing crate-isolation contract.
- `dataviewRender.ts`: jsdom unit tests for each result shape + the error
  branch. IPC wrapper: type-and-shape smoke.
- The live editor widget (detection, cursor reveal, re-eval on tick) is
  **operator-smoke-only** (Contract E) — logic lives in the pure modules
  above; the widget is the thin untested host.

## 8. Scope boundaries (explicit non-goals for L4-D)

Deferred, not designed away — each is an additive layer later:

- `OR` / parentheses in `WHERE`; a `contains` / substring operator.
- `GROUP BY` / `FLATTEN`.
- Typed dates / relative dates (lexical ISO compare suffices for v1).
- Computed/formula columns (the Bases-style direction).
- Inline (`key:: value`) field syntax — Cubical uses YAML frontmatter.
- Writing results back into the file. Never — derived state only.

## 9. Definition of Done

- `cubical-query` crate: parse + plan + exec, unit-tested.
- `dataview_query` IPC + TS wrapper + shape smoke.
- Editor widget detects ```` ```query ````, renders list/table/count,
  reveals raw source on cursor entry, re-evals on `searchRefreshTick`.
- `dataviewRender` jsdom tests green.
- Six gates green (`cargo test`/`clippy`/`fmt`, `tsc`, `vitest`,
  `build`); operator smoke recorded; merge to `main`; tag `l4d`.
- Then the L4 layer-close (kickoff §"After L4-D") and tag `l4`.
