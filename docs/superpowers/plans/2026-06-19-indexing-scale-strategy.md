# Indexing & Reactivity at Scale — Strategy / Decision Record

**Date:** 2026-06-19
**Type:** Strategy doc, *not* a step-by-step implementation plan. Nothing here
is scheduled. It is evidence-gated: the recommended first action is to
**measure**, then choose levers based on numbers, not fear.
**Audience:** a future session deciding whether/how to harden indexing for
large vaults. Read the "How to use this doc" section first.

---

## How to use this doc

Do **not** implement levers top-to-bottom. Each lever below has **Why**,
**How**, **Against (devil's advocate)**, and a **Trigger** (the evidence that
would justify doing it). Pick a lever only when its Trigger is actually met.
If no Trigger is met, the correct action is "do L0 (measure) and stop."

The two viewpoints are recorded deliberately:
- **For** = the case that this helps at scale.
- **Against** = the strongest argument not to do it / where it bites.

A future session should weigh both against real measurements, not adopt the
"For" side by default.

## Context & non-negotiables this must respect

"Scale" here = a **large single-user vault** (tens of thousands of notes),
*not* multi-user/server. Multi-user is out of scope by architecture (no
centralized cloud DB). Any change must keep:

- Plain `.md` is the **source of truth**; libSQL is **rebuildable derived
  state**.
- **Low memory** (on-disk SQLite, not an in-RAM graph) — this is our
  deliberate divergence from Obsidian and a feature, not a bug.
- **SQLite single-writer** is a hard constraint: every write path serializes
  on one lock. Most levers below bump into this; none fully escape it.
- Types are **frontend-only inline comments** (per-note). The DB is
  type-agnostic. Several levers threaten this boundary — flagged where so.

## Current reactive model (recap, so this doc stands alone)

1. **FS watcher** (`notify`/FSEvents, debounced) → emits `WatchEvent`.
2. **Dispatcher** (`crates/cubical-app/src/events.rs`): per changed markdown
   file, re-parses and re-runs `refresh_frontmatter` / `refresh_links` /
   `refresh_tags` / `refresh_blocks` / `refresh_block_refs_for_file`
   (currently **row-by-row, un-batched, sequential**), updates `files` +
   `content_hash`, writes `audit_log`, emits `vault:file-changed`.
3. **Frontend** (`ui/src/App.tsx` `onVaultFileChanged`): debounced
   `scheduleRefresh()` + invalidate cached resolvers (wikilinks, embeds,
   dataview); the open file's own autosave echo is deduped via `content_hash`.
4. **In-document**: Solid signals update the open doc instantly (editor → AST
   tick → `propertiesFrontmatter` → Properties rows), independent of the
   file→watcher→DB→event round-trip.

Per-file edits are **O(1) in vault size** — this backbone is correct and
should not be rethought.

## The pattern we already have, and its domain of validity

`pending_rewrites` (`crates/cubical-core/src/vault/pending.rs`, migration
`006`) is the "defer the heavy work" cache. On a rename touching N backlinks
it records **N cheap intent rows** instead of rewriting N files, applies them
**lazily on read** via `materialize_on_read`, and **flushes in the
background** (`pending_rewrites.flush_interval_secs`, default 300).

**Why it works:** the *unit of read* (one file) equals the *unit of deferred
work* (that file's rewrites), and the transform is a cheap, local token
substitution. Read-time materialization is therefore O(small).

**Where it does NOT generalize (critical):** indexing reads are usually
**aggregate** — a Dataview query / backlinks / graph reads *many files' rows
at once*. You cannot lazily materialize an aggregate's correctness without
indexing every dirty file it touches. So "just apply the pending pattern to
inbound re-indexing" is **partly a false analogy** (see L3 Against). The
honest reusable lesson is "record intent cheaply + reconcile out of band,"
not "lazy per-read materialization fixes everything."

## How Obsidian compares (design context, general knowledge)

Obsidian keeps its metadata cache **in RAM** (persisted to disk for warm
restart): fast queries, but high memory + slow cold start on huge vaults.
Reactivity is event-based; Dataview maintains its own incremental in-memory
index. Bulk rename is **brute-forced** (known to lag) — it has no
deferred-rewrite equivalent, so our `pending_rewrites` is arguably *better*
there. Takeaway: we trade query speed for low memory + graceful renames.
Don't "fix" scale by drifting toward an in-RAM graph; that surrenders our
main advantage.

## Strain points (all currently UNMEASURED)

1. **Bulk inbound change** (git pull / cloud sync / mass find-replace) →
   event storm + sequential, un-batched per-file re-index. Degrades to
   seconds–minutes of churn + temporarily stale aggregates. Not a crash.
2. **Typed / range Dataview queries** — values stored as JSON `TEXT`; ranges
   and sorts are lexical, no typed index; re-eval on every change.
3. **Cold start of a very large vault** — one-time O(n) parse, amortized by
   `content_hash` skip.

## Guiding principles (apply before any lever)

- **Measure first.** We have zero benchmarks. Instrumentation beats
  architecture.
- **Correctness > latency.** Slow-but-correct aggregates are safer than
  fast-but-silently-stale. Be very suspicious of any lever that introduces a
  staleness window in query results.
- **Prefer local, non-deferred wins** (reduce write volume / batch) over new
  subsystems (queues, workers, caches) that add permanent bug surface and are
  hard to test deterministically (this repo defers component tests).
- **Respect single-writer.** If write throughput is the ceiling, reducing
  write *volume* beats parallelism.
- **YAGNI.** Don't build for a load you haven't observed.

---

## Levers

### L0 — Instrument the hot paths  ·  do this FIRST, always safe

**Why.** Every claim in this doc is reasoned, not measured. Without timings we
risk optimizing the wrong thing.
**How.** Add timing/tracing around: per-file re-index (parse + each refresh),
dispatcher burst size + drain time, Dataview query eval, cold-start scan.
Surface as logs (or a dev overlay). Capture numbers from a real large vault
(10k+ notes; ideally a 50k synthetic).
**Against.** Almost none. Slight overhead; keep it cheap/sampled. The only
"why not" is if a strain point is already painful enough that the fix is
obvious — even then, measure to confirm the fix worked.
**Trigger.** Always, before L1–L5.

### L1 — Reduce write volume on the per-file path  ·  low risk

**Why.** The re-index does `DELETE all keys + reinsert all` per file even for
a one-key edit, and writes row-by-row. That's wasted writes on the
single-writer lock — the real ceiling. Cheaper writes help *both* steady-state
and bulk.
**How.** (a) Wrap each file's deletes+inserts in **one transaction** (or
`execute_batch`). (b) **Diff** existing rows vs. parsed entries and only
`INSERT`/`UPDATE`/`DELETE` what changed. Read all needed source from disk
*before* opening the transaction (don't hold the writer lock across I/O).
**Against.** Diffing adds logic + tests; for tiny files the delete-all cost is
trivial, so the win is mostly on large frontmatter / bulk. A per-file
transaction is fine; a *batch-spanning* one is not (see L3 Against).
**Trigger.** L0 shows per-file re-index or bulk drain dominated by write time.

### L2 — Make bulk indexing legible  ·  low risk, UX

**Why.** A 1,200-file `git pull` *should* take a moment; the problem is it
looks like a freeze. Obsidian shows "indexing…". Converting an unavoidable
cost into an expected, visible state may be the entire "fix" users need.
**How.** Emit a coarse progress signal during large bursts; show a
non-blocking "Indexing N files…" indicator; keep the open doc interactive.
**Against.** Doesn't make it faster, only legible. If the underlying churn
blocks interactive saves (writer lock), a progress bar over a janky editor is
lipstick — pair with L1.
**Trigger.** L0 shows bursts long enough to notice (> ~1s) but not pathological.

### L3 — Defer/queue inbound re-index (dirty-flag + background worker)  ·  HIGH risk, gated

**Why (For).** Returns control instantly on a big burst by recording "file X
is dirty" (cheap) and reconciling in the background — the spirit of
`pending_rewrites` applied to inbound change. Smooths the worst bursts.
**Against (devil's advocate — take seriously):**
- **Staleness in aggregates.** Unlike rename rewrites, indexing feeds queries
  / backlinks / graph that read many files at once. Deferring means those
  return **stale or wrong** results until the worker drains — silent wrong
  answers, worse than visible slowness. `materialize_on_read` does **not**
  rescue this (it's per-file, not per-aggregate).
- **New bug factory.** Crash recovery (dirty rows must survive a kill + resume
  idempotently), double-change/change-then-delete coalescing, back-pressure
  when sync outruns drain, and contention with interactive saves on the
  single writer lock — you may relocate jank, not remove it.
- **Hard to test** deterministically (timing/concurrency) in a repo that
  already defers component tests.
**How (if ever).** Durable dirty-set table; idempotent re-index keyed by
`content_hash`; coalesce per path; bounded background worker; **explicitly
mark aggregates "indexing in progress"** so the UI never presents stale query
results as authoritative. Only after L1+L2 prove insufficient.
**Trigger.** L0 shows bulk bursts are *frequent* (not just initial sync) AND
L1/L2 leave them painful AND staleness can be made visible/safe. If bursts are
rare (mostly first clone), **do not build this.**

### L4 — Typed / range query support  ·  medium risk, gated, prefer the cheap path

**Why (For).** `price > 100`, date ranges, and sorts are lexical string ops on
JSON `TEXT` today — slow on big tables and sometimes wrong.
**Cheap path first (preferred).** SQLite **expression indexes** /
`CAST(value AS REAL)` give typed comparisons with **zero schema change** and
no new coupling. Try this before anything structural.
**Structural path (typed projection) — Against (devil's advocate):**
- **Re-couples types to the DB.** We deliberately kept types frontend-only;
  a typed column/side-table forces the backend to parse `# type:` comments,
  eroding that boundary.
- **Contradicts per-note types.** Types are per-note; a typed *column* assumes
  one type per key vault-wide (rejected). A per-row typed side-table is the
  honest form but is more complex and ambiguous when notes disagree.
- **Dual-write cost** fights L1/L3 (more writes per change).
- **Query-result caching is cache-invalidation** — a `WHERE` over all notes
  depends on all notes; get the dependency set wrong → silently stale results.
**How (if ever).** Start with expression indexes. Only if profiling proves
them insufficient, add a per-row typed projection populated from inline types,
with explicit handling of per-note disagreement, and treat any query cache as
optional and dependency-tracked.
**Trigger.** L0 shows real, repeated slow typed/range queries on a large
vault — not a hypothetical.

### L5 — Parallelize cold-start parse  ·  low ROI, probably skip

**Why (For).** First index of a 100k vault is a one-time O(n) parse.
**Against.** Single-writer means only the *parse* parallelizes (writes
serialize); parallel I/O can **thrash** on cloud-synced folders (iCloud/
Dropbox) where many vaults live — possibly slower. `content_hash` already makes
it a one-time cost. Low ROI vs. added thread-pool/error-aggregation
complexity.
**How (if ever).** Bounded parse worker pool feeding a serial writer; cap
concurrency low on networked filesystems.
**Trigger.** L0 shows cold start is both slow *and* parse-bound (not I/O-bound)
on a vault users actually have.

---

## Recommended sequence (the conservative read)

1. **L0 — measure.** Get real numbers from a large vault.
2. **L1 + L2** — the safe, local wins (cheaper writes + legible bulk). High
   value, low risk, no staleness, no new subsystem.
3. **Stop and re-measure.** L1/L2 may close the gap entirely.
4. Only if evidence demands: **L4 cheap path** (expression indexes) for
   queries; **L3** for bulk *only if bursts are frequent and staleness can be
   made safe*. Treat L3's worker and L4's projection as last resorts with
   real triggers, not defaults.

## Decision checklist for the future session

Before picking any lever, answer with evidence:
- What does L0 say is actually slow? (If unknown, do L0.)
- Is the painful case **frequent** or a **one-time** event (initial sync)?
- Does the lever introduce a **staleness window** in query results? If yes,
  can it be made *visible* and *safe*? If not, reject.
- Does it **re-couple types to the DB** or assume **vault-wide** types? If yes,
  prefer the cheaper, boundary-preserving alternative.
- Does it add a **concurrency/cache** subsystem that's hard to test here? If
  yes, demand a strong Trigger.
- Does it fight the **single-writer** constraint head-on, or reduce write
  volume? Prefer the latter.
