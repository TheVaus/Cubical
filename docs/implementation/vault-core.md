# Implementation — vault core (`cubical-core`)

Design owner: [`../architecture/vault.md`](../architecture/vault.md) and
[`../architecture/concurrency.md`](../architecture/concurrency.md).

## Atomic writes

**Anchors:** atomic_write · VaultError

Temp-file → write → `fsync` → `rename` over the target. On Windows the rename
retries with exponential backoff before surfacing failure (antivirus and
OneDrive hold transient locks); the temp file is preserved on final failure so
a human can recover.

The API is **synchronous on purpose** — callers wrap it in
`spawn_blocking`. Both the write and the `rename` block, and an async facade
would only hide that cost.

Not safe to call concurrently on the same target: the temp path is derived from
the target, so racing writers clobber each other. The parent directory must
already exist.

## File-type registry

**Anchors:** FileTypeRegistry · BinaryHandler

Handlers are queried in **registration order**; the first whose `matches`
returns true claims the file. `BinaryHandler` matches unconditionally, so it
**must be registered last** or it shadows every specific handler. Custom
registries (tests, headless tooling) may omit it and accept `None`.

## Scan

**Anchors:** scan · open_vault · last_seen

- **Batched commits.** Autocommitting per file means one `fsync` per file —
  tens of thousands on a large vault, the difference between seconds and
  minutes. A re-scan resumes cleanly from the last committed batch.
- **Two-pass link resolution.** Pass 1 buffers link extractions per file; pass 2
  resolves them against the *complete* file set. `WalkDir` yields entries in
  unspecified order (APFS hash order, not alphabetical), so two files linking
  to each other would otherwise leave whichever was visited first unresolved.
  Both must resolve on the very first scan regardless of walk order.
- **Stale sweep.** Pass 1 stamps every on-disk file with `last_seen`; rows
  still older afterwards vanished from disk while the app wasn't watching and
  are deleted so they stop surfacing in the tree. Skipped under cancellation,
  where an incomplete walk would make live rows look stale.
- **Cooperative cancellation** is checked between files. The search refresher is
  the heaviest per-file step, so it is skipped once cancellation is in flight to
  hold the cancellation budget; upsert is idempotent, so a skipped file
  converges on the next scan.
- Per-file I/O or hash failures are logged and skipped, never fatal. The
  progress channel is best-effort — a dropped receiver silently discards
  updates rather than failing the scan.

`open_vault` returns as soon as the directory is validated and the index is
open; the walk runs separately, which is what keeps vault-open time independent
of vault size.

**The cancellation test asserts the property, not a latency** — the same rule
the watcher's drop test follows, and for the same reason. It verifies that a
cancelled scan settles, reports `ScanCancelled`, and leaves a partial row count;
never how many milliseconds that took. The earlier version measured
`t0.elapsed()` against a 100 ms bound while carrying a 500 ms `timeout`, so the
name and the deadline already disagreed. That span crosses an `await` on a
runtime shared with the rest of the suite, so it measured the machine — it
passed on a developer's Mac and failed on a loaded CI runner. The remaining
`timeout` is a **liveness** bound set far clear of scheduling noise: if it fires,
cancellation genuinely hung. See [#52](https://github.com/TheVaus/Cubical/issues/52).

## Vault-relative paths

**Anchors:** to_vault_relative · WatchEvent · scan · validate_rel_file

A path stored anywhere — the `files` and `folders` tables, a `WatchEvent`, the
rename journal, the own-writes key — is a **vault-relative string joined with
`/` on every platform**. Exactly two things produce one. Paths discovered on
disk go through `to_vault_relative` (the scan and the watcher's `relativize`).
Paths arriving from a caller go through `validate_rel_file`, which is why
`rename_file` stores a `/`-form key on Windows rather than whatever the request
spelled — see *Caller-supplied paths* in
[`engine-ipc.md`](engine-ipc.md). A backslash is **rejected** there rather than
translated: on Unix it is a legal filename byte, so rewriting it would name a
different file.

This is a correctness rule, not a formatting preference. `Path`'s native
separator is `\` on Windows, so a stored path built by stringifying a `PathBuf`
diverges per platform, and everything keyed on that string stops matching: a
`[[wikilink]]` resolves against `projects/2026/note`, the rename journal
replays against a path that no longer spells the same, and the own-writes set —
whose key is built from a `/`-form request path — never matches the watcher's
event, so the app re-indexes its own writes in a loop.

`WatchEvent` therefore carries `String`, not `PathBuf`. Handing downstream a
`PathBuf` would let any consumer reintroduce the platform separator with an
ordinary `to_string_lossy()`, which is exactly how this broke: the type is what
makes the invariant hold, not discipline at each call site.

## Watcher

**Anchors:** WatchEvent · Vault · scan

Wraps `notify` behind `notify-debouncer-full` for inode-based rename
correlation and event coalescing. **`notify` types never leak across the crate
boundary** — callers see only vault-relative `WatchEvent`s, so the underlying
watcher can be swapped without rippling.

Dropping the handle tears down the OS watch and aborts the bridge task; no
further events arrive. The cancel token is a softer signal: the bridge stops
forwarding, but the OS watch stays up until the handle drops.

**The drop test asserts the property, not a latency.** It verifies that the
channel closes and that a write afterwards delivers nothing — never *how fast*
that happens. An earlier version measured wall-clock elapsed against a 500 ms
bound (while being named `…_within_100ms`) and failed routinely: the assertion
fired with `Ok(None)` already returned and the 500 ms `timeout` not yet
triggered, which is the signature of executor starvation, not a watcher defect.
`t0.elapsed()` spans an `await` on a runtime sharing cores with ~190 other
tests, so it measured the machine. Observed values ranged past 6 s under gate
load. The remaining `timeout` is a **liveness** bound set far clear of
scheduling noise — if it ever fires, the bridge genuinely did not close.

**Exclusions** mirror the scan's skip set: anything under `.cubical/`, `.git/`,
`node_modules/`, or any dot-prefixed directory. Without this every libSQL write
under `.cubical/` echoes back as an event and re-triggers a write.

The `.cubical-tmp` suffix is filtered by **filename**: without it every autosave
echoes three events (temp create + temp modify + target modify) and the temp
path leaks into the `files` table before the rename.

### Platform quirks

- **macOS trash-delete arrives as a rename.** `trash::delete` surfaces through
  FSEvents as `ModifyKind::Name(RenameMode::Any)` — not `Remove`, not
  `From` — carrying a single path with no side information. Disambiguate the
  same way an unpaired `Both` half is resolved: if the path no longer exists on
  disk, it is the vanished side.
- **Create swallows later events.** `notify-debouncer-full` coalesces
  `Create` followed by `Modify`/`Remove`/`Rename` for the same path inside its
  window, and FSEvents accumulates a per-path flag bitmask, so a write to a
  pre-existing file can still report as `Create`. Tests asserting on a
  non-`Create` event must stage the file **before** the watch starts. The
  kind→`WatchEvent` translation is unit-tested against synthetic events; the
  end-to-end modify/remove/rename flows are covered by the operator smoke pass,
  where the file long predates the watcher.

## Refreshers

**Anchors:** refresh_frontmatter · refresh_links · refresh_tags · refresh_blocks

`frontmatter`, `links`, `tags`, `blocks` and the search doc all follow one
shape: **delete-then-insert keyed on the file path**. Idempotent across
re-scans, naturally drops keys the user removed, no diff bookkeeping.

The caller must ensure the `files` row exists first so the foreign key has a
parent. On read or parse failure the file's rows are **wiped rather than left
stale** (treated as "no links"/"no tags"); SQL errors propagate so the caller
decides whether to retry, and the scan and watcher paths log and continue.

Parsing runs in `spawn_blocking` (CPU-bound); the DB writes stay on the async
runtime.

### Parse once, fan out

Every refresher pairs up: `refresh_x(vault, path, source)` parses and delegates
to `refresh_x_with_doc(vault, path, &doc)`. `vault::parse_off_executor` is the
**single** owner of the `spawn_blocking` parse hop — the refreshers no longer
each keep a private copy.

Callers holding one file's source (scan, the watcher, both rename paths) parse
once up front and call the `_with_doc` arm, so a file is parsed **once**, not
once per consumer. Before this, a scanned file went through `cubical_ast::parse`
four times — frontmatter, links, tags, and the search projection — plus three
more `parse_frontmatter` passes inside the projection, each behind its own
`spawn_blocking` hop and its own full copy of the source. On a 10k-note vault
(~88 MiB) that was ~25% of cold open+scan: **5.78 s → 4.35 s** median, measured
release-build on an M1 Pro.

`refresh_blocks` deliberately stays source-only: block IDs are a line scan, not
an AST walk, so it has no `Document` to share.

The `_with_doc` arms are the load-bearing ones; the source-taking wrappers exist
for single-file callers that have no `Document` in hand. Both must stay
behaviourally identical — `parse` and `parse_frontmatter` return the same
frontmatter for the same source, which is what makes `Document::frontmatter`
a safe substitute for a second parse.

### Materialize-on-read

**Anchors:** materialize_on_read · content_hash

Both write paths read each markdown file **once** and apply any pending
rewrites before handing the text to every extractor. Without this, scan-derived
tables reflect the *old* tokens until flush, so backlinks and tag listings
would disagree with the editor's materialized view.

`files.content_hash` is deliberately computed against the **raw on-disk bytes**
and left untouched by materialization — it tracks the unrewritten file for
change detection.

## Link resolution order

**Anchors:** PathResolver · resolve_target · keeps_link_row

1. Exact vault-relative path (with or without `.md`).
2. Unique case-insensitive basename.
3. Unique case-insensitive path suffix.

Ambiguity at levels 2–3 resolves to `None`. The bulk scan builds the resolver
index once; exact and basename lookups are O(1) and the suffix stage is a
linear fallback that only runs when the first two miss.

A dotted target (`[[Report v1.2]]`) is classified by the tokenizer as a
property-ref and is persisted as a link **only** if it resolves to a real file
— file-existence-wins precedence. Every other occurrence is stored even when
broken, so the UI can surface it and a later rename can re-resolve it.

## Tags

**Anchors:** extract_tags · TagExtraction

Two declaration sources feed one extraction: inline `#tag` tokens and
frontmatter `tags:` entries, discriminated by a `source` field. Within a file,
rows dedupe by `(lowercase(tag), source)` — case-insensitive matching,
case-preserving display, first-seen casing wins.

Frontmatter `tags:` accepts hand-written shapes beyond a YAML list:
`tags: foo`, `tags: "foo, bar"` and `tags: "foo bar"` all split into
individual tags, and a leading `#` is stripped if present.

## Pending rewrites

**Anchors:** apply_pending · PendingRewriteRow · extract_block_ids

`apply_pending` is pure: source + rows in `created_at` order → rewritten
source. Each rewrite produces a new full string feeding the next, i.e.
O(rewrites × len) — fine under the per-file ceiling.

- **WikiLink** — re-emits matching targets through the tokenizer, preserving
  the embed flag, `|display` and `#anchor`.
- **Tag** — two passes: a targeted rewrite of `tags:` entries operating on the
  **raw frontmatter block text** (so key order, quoting and comments survive —
  never reparse and re-emit YAML), then an inline body pass applying the tag
  boundary rules to exact matches and nested prefixes. Quote handling is
  minimal by design: `"foo"`, `'foo'` and bare `foo`, preserving the outer
  quotes and any leading `#`.
- **BlockRef** — referrer `[[file#^old]]` via the tokenizer, plus the
  defining-line `^old` via a line walk. Both patterns are attempted per row;
  the defining-line pattern can only match in the defining file, which is what
  makes one uniform pass safe.

## Rename durability journal

**Anchors:** RenameJournalEntry · serialize_entry · parse_all · compact · append_entry

`pending_rewrites` is the one piece of index state that is **not derivable**
from the `.md` files, while the file move itself is committed to disk
immediately. So wiping the (otherwise disposable) index mid-rename would lose
the `Old → New` mapping and strand referrers with broken links and no
breadcrumb.

The journal closes that hole: an append-only JSONL log in `.cubical/`, one
object per rename op — zero `.md` bytes, no UUIDs, portable. The core module is
pure (serialize / parse / compact); file I/O and scan integration live with the
command layer. See [`engine-ipc.md`](engine-ipc.md) for replay.

## Unlinked mentions

**Anchors:** extract_text_runs · find_mention_occurrences · MentionHit

Pure, on-demand, no index table: walk the source for plain-text regions
(skipping frontmatter, fenced and inline code, wiki-links and markdown links),
then match needles whole-word and case-insensitively. Matching operates on a
lowercased copy and maps back through the original's `char_indices`, so
casefolding that changes byte length stays correct. One linear scan per needle
— the needle set is small (a title plus a few aliases).
