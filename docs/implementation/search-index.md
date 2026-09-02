# Implementation — index, search, queries

Schema owner: [`../architecture/document-model.md`](../architecture/document-model.md).
This file records query-layer and search-layer invariants only.

## Migrations (`cubical-index`)

**Anchors:** open_index · SchemaTooNew · IndexError

Linear `(version, sql)` pairs applied in ascending order. `open_index` is the
only entry point: it opens or creates the database and brings the schema up to
date.

- **Atomic.** Every pending migration runs in *one* transaction together with
  the version bump. A failure rolls back and leaves the on-disk state —
  including the recorded version — untouched.
- **Idempotent.** Calling it twice on the same path is a no-op the second time.
- **A future schema is refused.** An on-disk version higher than this build's
  highest known migration returns a schema-too-new error without touching the
  file.
- The parent directory must already exist; the runner never creates
  directories.
- The runner never destroys anything. What happens when the file itself is
  unreadable is `Vault::open`'s call —
  [`vault-core.md`](vault-core.md) → Index recovery.

**Adding one:** drop `migrations/NNN_<name>.sql` (zero-padded, one greater than
the last), append the entry wired via `include_str!` in ascending order — the
runner trusts that ordering — and **never edit a migration that has shipped.
Fix it forward with a new one.**

## Table notes

- **`folders`** exists only so *empty* directories survive in the file tree,
  which is otherwise derived from file paths. Fully derived and rebuildable —
  the on-disk directory is truth, re-discovered by every scan. Paths are
  vault-relative with no leading or trailing slash; the root is never stored.
- **`files` is layer 0's table, and only `cubical-index` writes SQL against
  it.** `all_file_paths` is the whole-vault path list every resolver needs;
  engine-side copies of the same `SELECT` drift from it silently, because
  nothing type-checks a string.
- **Link rows keep an unresolved target.** A row whose target didn't resolve at
  extraction time is still written, so the backlinks UI can surface the broken
  link and a later rename can re-resolve it.
- **Pending rewrites are grouped by rename op id**, so a single undo deletes
  exactly what one rename enqueued.
- **Row replacement participates in the caller's transaction.** The
  delete-then-insert pair executes directly on the caller's connection rather
  than opening its own transaction, so the scan and watcher hot paths get
  atomicity from their per-batch transaction.

## Dataview queries (`cubical-query`)

**Anchors:** json_extract · Relation · conformance

A small `LIST` / `TABLE` / `COUNT` DSL with `FROM` / `WHERE` / `SORT`. One
grammar and one AST serve two record sources: notes in the index, and
`.csv` / `.tsv` / `.xlsx` / `.xlsm` data files decoded by `cubical-table`.

- Frontmatter values are stored as JSON-encoded text, so every comparison and
  projection goes through `json_extract(value,'$')` to unwrap to a native
  scalar.
- **Every literal and key is a bound parameter — never interpolated.** This is
  what makes a user-authored query block unable to inject SQL. Do not "just
  format" a value into the SQL string.

### One language, two executors

`Relation` picks the executor: `Relation::Index` compiles the AST to
parameterized SQL, `Relation::Table` filters a decoded table in memory.
Notes go through SQL because they are already indexed; a data file is read
per query because indexing arbitrary spreadsheet rows would put unbounded
derived state in the index for no gain.

The parser stays free of file formats. `FROM "…"` yields `Source::Path`, a
path and nothing more; whether it names a folder or a data file is decided at
resolution time by what is on disk, which is why a folder whose name ends in
`.csv` is not a special case. The `#SheetName` fragment is likewise plain path
text until the engine splits it.

`cubical-engine` owns resolution because it is the layer that may use
`vault::relpath` — layer 1 cannot reach up to it, and a second containment
check living next to the executor would be a second answer to a question that
already has an owner.

### The semantics both executors must agree on

Two implementations of one language drift silently, so the rules live in the
`conformance` suite: the same logical records materialized both as index rows
and as a table, every case asserted equal through both executors. A new clause
is not done until it has a case there.

- Comparison follows the **literal's** type. A string literal compares against
  the value's text form, a number literal against its numeric form, a boolean
  against its boolean form. A value with no form of that type never matches —
  which is why `WHERE code >= 0` skips a `code` of `"x1"` instead of coercing
  it to zero.
- **A missing value never matches any comparison, including `!=`.** On the SQL
  side that is the `EXISTS` wrapper; on the table side an absent column or an
  empty cell. `WHERE status != "done"` therefore does not surface records that
  have no `status` at all.
- `SORT` puts missing values last in **both** directions, then orders numbers
  before text.

A file format's own type system is the one thing that legitimately shows
through. YAML declares its types, so a frontmatter `"3"` is a string with no
numeric form; CSV declares nothing, so a cell reading `3` carries both a text
and a numeric form and answers to either literal. `Cell` keeps the original
text alongside the inferred forms precisely so that inference never destroys
what the file said — a `code` of `007` still equals the string `"007"`.

### Decoding data files (`cubical-table`)

**Anchors:** TableCache · supports_extension

`.csv` / `.tsv` via the `csv` crate, `.xlsx` / `.xlsm` via `calamine`; first row
is the header, remaining rows are data, and an empty file or sheet is an empty
table rather than an error. A `#SheetName` fragment selects a sheet and a bare
workbook path takes the first one.

- **`Cell` is lossless.** `text` is always what the file said; `num` and
  `boolean` are *additional* readings layered on top. Type detection trims,
  `text` does not. This is what lets a `007` answer both `= "007"` and a
  numeric comparison without the inference destroying the original.
- Excel dates render as ISO-8601 strings with no numeric form, so they compare
  the way frontmatter dates already do. Formula cells read their cached value;
  nothing is evaluated.
- **The cache's correctness comes from the `stat`, never from an event.** Every
  load stats the file and re-decodes when mtime or size moved, and a decode is
  only stored when the stat is *still* unchanged afterwards, so a file rewritten
  mid-decode is returned but never retained. `invalidate` is an optimization for
  a caller that already knows: forgetting it costs one extra `stat`, never a
  stale read. That independence is the point — an event-invalidated cache would
  be a second freshness protocol to keep in step with the watcher.

### Results

A result row's link is optional. Note rows carry a `NoteRef` and the table
result sets `row_label` to `File`; data-file rows carry neither, and the
renderer omits the leading column rather than inventing a path for a
spreadsheet row.

## Full-text search (`cubical-search`)

**Anchors:** SearchIndex · rebuilt_reason · is_recoverable_by_wipe

Every byte in the search directory is derived from the `.md` files, so wiping
it costs a rescan and nothing else. `SearchIndex::open` therefore wipes and
retries **once** rather than failing: first when `schema.json` is missing or
not the current `SCHEMA_VERSION`, then again if building the index, writer or
reader fails anyway — the case a stamp check cannot see, where the stamp is
current but the segment files are not. `rebuilt_reason` carries why, so
`Vault::open` can write the `search_rebuilt` audit row instead of healing
silently.

Two failures are excluded from the retry, because for them a wipe destroys
rather than repairs: a writer `LockFailure` means another process holds the
directory, and an I/O error means the filesystem is the problem (permissions, a
full disk) and deleting files will not fix it.

Known limit: corruption that only surfaces at query time still surfaces at
query time. Open-time healing covers what open-time can observe.

One Tantivy document per `.md` file with structural fields (title, headings,
body, code, tags, frontmatter). Default-scope boosts are
`title^3 + headings^2 + tags^2 + body + frontmatter`; a field scope swaps the
parser's default fields, and single-term queries in the default scope can be
rewritten to a fuzzy query against the title. Plain word queries also get
search-as-you-type prefix matching OR'd with the exact term.

### Field projection rules

`project_with_doc` is the real projector; `project(path, source, …)` is the
convenience arm that parses first. Every field — including `title`, `tags` and
the flattened `frontmatter` string — is read off the passed `Document`, so
projecting costs **no parse at all** when the caller already has one. See
[`vault-core.md`](vault-core.md) → Parse once, fan out for who supplies it.

A single walk projects blocks into the field strings:

- `headings` takes ATX heading text only — the walker never descends into
  headings for body text.
- `body` accumulates prose, list items, blockquotes, table cells, image alt
  text, and wiki-link display text (the alias when set, else the target's last
  path segment).
- `body` **excludes** fenced and inline code, wiki-image embeds, raw `[[…]]`
  syntax, raw `#tag` tokens, raw `^block-id` markers, frontmatter, HTML, and
  transcluded content.
- `code` takes fenced and inline code text.
- Tags are lowercased at projection time so a `tag:` field query parses to the
  same form as the indexed value.

Block-id stripping is deliberately **broader** than the defining-line rule used
when rewriting: by the time text reaches the AST, soft breaks have folded into
spaces, so line position is unknowable. The body field is text-only and never
rendered structurally, so removing a stray `^foo` from the searchable text is
the correct outcome anyway.

### Result contract

**Anchors:** total_estimated

- **`total_estimated` is not a match count.** It is the size of the top-K
  window the runner pulled (`min(matches, limit + offset)`). Frontends must
  **not** render it as "X total results" — it is only an "is there another
  page?" hint. A true count needs a second counting pass, which is not paid
  for.
- Under recency sort the score field carries the mtime cast to `f32`. The cast
  is lossy, but ordering stays correct because the sort happens on the i64
  before the cast. Treat the value as an opaque sort-key remnant, not a score.

### Index lifecycle

- **Orphan reconcile after a scan.** Files renamed or deleted while the app
  wasn't watching produce no watcher event, so their documents would linger and
  surface stale hits. The index is derived state, so dropping anything not in
  the authoritative on-disk set is always safe.
- **Rebuild keeps the handle alive.** Wipe documents and commit rather than
  deleting the on-disk directory — destroying the directory under a live writer
  races the OS-level mmap. The wipe holds the writer guard while marking the
  deletion so it is safe against concurrent upserts.
- Callers commit; the scan commits on a document interval and the watcher on
  its debounced cadence.

### Benchmark driver

`cargo run --release -p cubical-search --example bench` issues a fixed query mix
and reports p50/p99/mean latency. It requires
`CUBICAL_SEARCH_BENCH_VAULT=<absolute-vault-path>` — there is deliberately no
default, so the driver never depends on one machine's directory layout. Without
it (or without a built index at that path) it prints what to set and exits 0.
