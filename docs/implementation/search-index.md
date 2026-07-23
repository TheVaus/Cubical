# Implementation — index, search, queries

Schema owner: [`../architecture/document-model.md`](../architecture/document-model.md).
This file records query-layer and search-layer invariants only.

## Migrations (`cubical-index`)

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

**Adding one:** drop `migrations/NNN_<name>.sql` (zero-padded, one greater than
the last), append the entry wired via `include_str!` in ascending order — the
runner trusts that ordering — and **never edit a migration that has shipped.
Fix it forward with a new one.**

## Table notes

- **`folders`** exists only so *empty* directories survive in the file tree,
  which is otherwise derived from file paths. Fully derived and rebuildable —
  the on-disk directory is truth, re-discovered by every scan. Paths are
  vault-relative with no leading or trailing slash; the root is never stored.
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

A small `LIST` / `TABLE` / `COUNT` DSL with `FROM` / `WHERE` / `SORT`, compiled
to parameterized SQL over the index tables.

Two invariants:

- Frontmatter values are stored as JSON-encoded text, so every comparison and
  projection goes through `json_extract(value,'$')` to unwrap to a native
  scalar.
- **Every literal and key is a bound parameter — never interpolated.** This is
  what makes a user-authored query block unable to inject SQL. Do not "just
  format" a value into the SQL string.

## Full-text search (`cubical-search`)

One Tantivy document per `.md` file with structural fields (title, headings,
body, code, tags, frontmatter). Default-scope boosts are
`title^3 + headings^2 + tags^2 + body + frontmatter`; a field scope swaps the
parser's default fields, and single-term queries in the default scope can be
rewritten to a fuzzy query against the title. Plain word queries also get
search-as-you-type prefix matching OR'd with the exact term.

### Field projection rules

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
