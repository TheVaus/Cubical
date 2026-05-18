# Cubical — Code Review & Fix (Segment 1: the code)

**Date:** 2026-05-18 · Scratch artifact — not committed.

## 1. Summary

The codebase is healthy. Tooling baseline is fully green: `cargo clippy --workspace
--all-targets -D warnings`, `cargo fmt --check`, `tsc --noEmit` all clean; 121 Rust
tests + 46 vitest pass. **No fix was applied** — twelve findings are reported but
not applied, each either touching behaviour/logic, carrying a design tradeoff, or
having a plausible intentional rationale. (One `.clone()`→`.as_str()` change was
briefly applied then reverted — see §2.) Notably well done: the migration-touchpoint
discipline (`events.rs` / `ipc.ts` as single chokepoints), the batched-transaction
scan writes, the pure/testable split of command handlers from Tauri, and the
deliberate crash-resilient (un-batched) audit-log writes in `write_file_text`.

**Counts:** Applied 0 · Suggested 12 (Correctness 2 · Performance 3 · Redundancy 3
· Quality 4).

## 2. Applied

**None.**

A candidate fix — replacing six `.clone()` calls with `.as_str()` where owned
`String`s are bound into libsql `params!` macros (`scan.rs:191`,
`events.rs:357-358,361,395,414`) — was applied as commit `d8841fe` and then
**reverted** as commit `7294dca`. On verifying against the libsql 0.6.0 source,
`impl From<&str> for Value` calls `value.to_owned()` (`value.rs:182-184`), so a
`&str` bind allocates a fresh `String` just as `.clone()` does — the change was
allocation-neutral, not the strict improvement the APPLY bucket requires. It is
behaviour-identical (compiler + 121 tests + clippy confirmed both directions), so
the `.clone()` form is fine as-is; it is the idiomatic way to pass an owned value
that is also reused afterwards. Net result: no code change, working tree restored.

## 3. Suggested (not applied)

### Correctness

#### C1 — `onCleanup` registered after `await` never runs (listener leak)
- **Location:** `ui/src/App.tsx:421-422`, `:427-430` (inside the `async onMount`).
- **Intent analysis:** the async `onMount` is there to `await` the four IPC
  `listen()` subscriptions; placing the `beforeunload`/`watchSystemTheme` setup in
  the same block looks like grouping-by-convenience, not deliberate design.
- **Problem:** Solid's `onCleanup` only registers under a synchronous owner; after
  the four `await`ed `listen()` calls the owner context is gone, so the
  `beforeunload` handler and the `matchMedia` change listener are never removed.
- **Why it matters:** a genuine reactivity bug — both listeners leak. Harmless for
  the root component today (it unmounts only at app teardown) but it will bite if
  `App` ever becomes remountable, and it is a latent footgun.
- **Fix:** move the listener setup out of the async block — register it
  synchronously in the component body (or a separate non-async `onMount`); it has
  no dependency on the IPC subscriptions.
  ```ts
  // before: inside `onMount(async () => { … await listen() ×4 … })`
  window.addEventListener("beforeunload", onBeforeUnload);
  onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
  const unwatchTheme = watchSystemTheme(…); onCleanup(unwatchTheme);
  // after: same lines, but in the synchronous component body
  ```
- **Not auto-applied:** fails gate (a)/(b) — it relocates logic and depends on
  Solid owner semantics; not behaviour-preserving with certainty.
- **Effort:** small · **Confidence:** medium.

#### C2 — `atomic_write` does not fsync the parent directory
- **Location:** `crates/cubical-core/src/vault/atomic.rs:45-66`.
- **Intent analysis:** `docs/layer-0-spec.md` §4 specifies the procedure verbatim
  as "temp-file + fsync + rename" — the missing directory fsync may be a conscious
  spec scoping decision, not an oversight.
- **Problem:** the write does temp-file → `sync_all` → `rename` but never fsyncs
  the directory; a crash between the rename and the dir-entry flush can lose the
  rename even though the file data was synced.
- **Why it matters:** undercuts the "plain `.md` files are the absolute source of
  truth" promise on power-loss.
- **Fix:** after `rename_with_retry` succeeds, open the target's parent directory
  and `sync_all()` it (Unix only; skip on Windows). This likely warrants a
  one-line update to spec §4 rather than a silent code change.
- **Not auto-applied:** fails gate (b)/(c) — adding behaviour beyond the written
  spec is a design call for the developer.
- **Effort:** small · **Confidence:** medium.

### Performance

#### P2 — Live Preview decorations iterate the whole syntax tree every keystroke
- **Location:** `ui/src/editor/decorations.ts:93` (`tree.iterate({enter})`, no
  range) via `buildFor` (`:314-321`), on every `docChanged`/`viewportChanged`/
  `selectionSet` update (`:331-341`).
- **Intent analysis:** the unbounded walk keeps `collectDecorations` pure and
  trivially unit-testable (it is tested directly against a parsed tree) — that
  testability is a deliberate design goal stated in the file header.
- **Problem:** the walk is O(document) per keystroke when CM6 only needs
  decorations for `view.visibleRanges`.
- **Why it matters:** on a large note every keystroke pays a full-tree walk; the
  project already virtualizes the file list for the same large-vault reason.
- **Fix:** thread `view.visibleRanges` into `collectDecorations` as a parameter
  and call `tree.iterate({ from, to, enter })` per range; keep a full-range
  default so the existing unit tests still pass.
- **Not auto-applied:** fails gate (a)/(b) — changes the decoration-computation
  surface and risks edge cases where a block straddles the viewport boundary.
- **Effort:** moderate · **Confidence:** medium.

#### P3 — Decoration set rebuilt on cursor moves that don't change the active line
- **Location:** `ui/src/editor/decorations.ts:331-341` (`update`).
- **Intent analysis:** rebuilding on any `selectionSet` is the simplest correct
  rule (the active-line reveal depends on the cursor) — simplicity over a caching
  optimization is a reasonable deliberate choice.
- **Problem:** moving the cursor within a single line fires `selectionSet` and
  triggers a full `buildFor` even though the active line — the only selection-
  derived input — is unchanged.
- **Why it matters:** needless full `DecorationSet` rebuilds during ordinary
  left/right cursor movement and within-line selection.
- **Fix:** cache the last active line on the plugin instance; when an update is
  `selectionSet`-only (doc/viewport/tree unchanged) and the new active line equals
  the cached value, skip the rebuild.
- **Not auto-applied:** fails gate (a)/(b) — adds stateful cache-invalidation
  logic; a wrong invalidation condition would produce stale decorations.
- **Effort:** small · **Confidence:** high.

#### P4 — Scan re-prepares the same SQL for every file
- **Location:** `crates/cubical-core/src/vault/scan.rs:187` (per-file `files`
  upsert); `crates/cubical-core/src/vault/frontmatter.rs:65` (per-key insert).
- **Intent analysis:** using `conn.execute` per row is the simplest correct form
  and matches the rest of the codebase; the scan was already perf-tuned for
  batching, so leaving statement-prep un-optimized may simply be "not yet needed."
- **Problem:** `Connection::execute` parses+prepares the statement each call — on
  a 30k-file vault that is 30k re-parses of one identical UPSERT.
- **Why it matters:** wasted CPU on the scan hot path the recent commits already
  targeted.
- **Fix:** `conn.prepare(sql).await?` once before the walk, reuse the `Statement`
  inside the loop (SQLite prepared statements survive the `tx.commit()`/reopen
  boundary).
- **Not auto-applied:** fails gate (a)/(e) — depends on libSQL `Statement` reuse
  and reset semantics across transactions that were not verified.
- **Effort:** moderate · **Confidence:** medium.

> **Retracted finding (was P1):** an earlier draft flagged the three un-batched
> writes in `write_file_text` (`vault.rs:434-482`) as a missing transaction. This
> was withdrawn: the comment at `vault.rs:425` states the override-audit row must
> survive *even if the later `files` UPDATE fails*, and all three statements use
> log-and-continue rather than `?`. The independent commits are deliberate
> crash-resilience; a transaction would defeat it. No change recommended.

### Redundancy

#### R1 — Error-message extraction copy-pasted four times
- **Location:** `ui/src/App.tsx:202-205`, `:308-311`, `:330-333`, `:481-484`.
- **Intent analysis:** four identical `unknown`→message blocks; most likely a
  helper simply not extracted yet in a mid-build file, not a deliberate choice.
- **Problem:** the same
  `typeof e === "object" && e !== null && "message" in e ? … : String(e)` block
  appears verbatim in `performWrite`, `handleSelectFile`, `reloadFromDisk`,
  `handleOpen`.
- **Why it matters:** four-fold maintenance surface for one concept.
- **Fix:** one module-level helper —
  ```ts
  function errorMessage(e: unknown): string {
    return typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
  }
  ```
  then replace each block with `setError(errorMessage(e))`.
- **Not auto-applied:** fails gate (b)/(d) — extraction involves naming/placement
  judgment and the file is actively-evolving L2 surface.
- **Effort:** trivial · **Confidence:** high.

#### R2 — Two request interfaces in `ipc.ts` are unused
- **Location:** `ui/src/api/ipc.ts:153` (`GetSettingRequest`), `:163`
  (`SetSettingRequest`). Confirmed via grep — zero references outside `ipc.ts`.
- **Intent analysis:** `ipc.ts` is the documented single-chokepoint mirror of the
  Rust IPC structs; keeping a complete type mirror even for inline-built requests
  is a plausible deliberate choice.
- **Problem:** every other `*Request` interface is consumed by its command
  function; these two are not — `getSetting`/`setSetting` build the request inline
  and use the typed `Setting` union instead.
- **Why it matters:** minor inconsistency / possible dead code.
- **Fix:** delete both interfaces — *or*, if a complete mirror is intended, leave
  them. Confirm intent first.
- **Not auto-applied:** fails gate (c) — plausible intentional API-mirror
  completeness; deleting exported types in a mid-build project is risky.
- **Effort:** trivial · **Confidence:** medium.

#### R3 — SHA-256 hex-encoding loop duplicated
- **Location:** `crates/cubical-core/src/file_type/mod.rs:142-146`
  (`sha256_bytes_hex`) and `:165-171` (`sha256_file_hex`).
- **Intent analysis:** two short, self-contained loops; duplication is small
  enough that "three similar lines beat a premature abstraction" could apply.
- **Problem:** the `String::with_capacity` + `write!("{:02x}")` loop is identical
  in both functions.
- **Why it matters:** minor — two copies of one trivial encoder.
- **Fix:** extract `fn hex_encode(digest: &[u8]) -> String` and call it from both.
- **Not auto-applied:** fails gate (b) — whether to extract is a judgment call the
  project's anti-premature-abstraction convention makes non-obvious.
- **Effort:** trivial · **Confidence:** high.

### Quality

#### S1 — `expect()` in library (non-test) code
- **Location:** `crates/cubical-core/src/vault/scan.rs:146`;
  `crates/cubical-index/src/runner.rs:121`.
- **Intent analysis:** both `expect`s carry detailed messages arguing the case is
  unreachable — the author reasoned about them deliberately — but `CLAUDE.md`
  Conventions states unconditionally "No `unwrap()` or `expect()` outside tests
  and `main`."
- **Problem:** convention violation in library crates.
- **Why it matters:** the convention exists so a future refactor that makes the
  "impossible" case reachable fails loudly via `Result`, not a panic.
- **Fix:**
  - `runner.rs:121`: `pending` is checked non-empty at `:109`; replace
    `.last().map(|m| m.version).expect(…)` with a `let Some(last) = pending.last()
    else { return Ok(()) };` (or compute `new_version` directly from the sorted vec).
  - `scan.rs:146`: make the `spawn_blocking` re-dispatch total —
    `let Some(handler) = registry_for_hash.handler_for(&abs_for_hash) else { return
    Err(FileTypeError::Io(std::io::Error::other("no handler"))) };`.
- **Not auto-applied:** fails gate (a)/(b) — both fixes change the error/control
  path and require choosing the replacement error value.
- **Effort:** trivial · **Confidence:** high.

#### S2 — *(withdrawn — not a finding)*
An earlier draft flagged the `.clone()` calls binding owned `String`s into libsql
`params!` as needless allocations. Withdrawn: libsql 0.6.0's `From<&str> for Value`
allocates anyway (`value.rs:184`), so `.clone()` vs `.as_str()` is allocation-neutral
and the current `.clone()` form is correct and idiomatic. See §2 for the full trail.

#### S3 — `INSERT OR REPLACE` after a full `DELETE`
- **Location:** `crates/cubical-core/src/vault/frontmatter.rs:53` (`delete_rows`)
  then `:66` (`INSERT OR REPLACE INTO frontmatter`).
- **Intent analysis:** the delete-then-insert strategy is documented; `OR REPLACE`
  on top could be deliberate belt-and-suspenders against a future where the
  `DELETE` is removed or the parser yields duplicate keys.
- **Problem:** all rows for `file_path` are deleted immediately before the
  inserts, so `OR REPLACE` can never trigger — it is currently inert.
- **Why it matters:** very minor — a no-op conflict clause.
- **Fix:** `INSERT OR REPLACE INTO frontmatter …` → `INSERT INTO frontmatter …`.
- **Not auto-applied:** fails gate (c) — plausibly intentional defensiveness;
  changing SQL semantics on a guess is not safe.
- **Effort:** trivial · **Confidence:** medium.

#### S4 — Needless shadow-rebinding to gain mutability
- **Location:** `crates/cubical-index/src/runner.rs:108` (`let pending … =
  …collect();`) then `:115` (`let mut pending = pending;`).
- **Intent analysis:** shadowing immutable→`mut` right before the first mutation
  is an idiom some Rust developers use deliberately to localize where mutability
  begins — this may be a conscious style choice, not an accident.
- **Problem:** the vec is collected immutably, then re-bound `mut` two lines later
  only to call `.sort_by_key`.
- **Why it matters:** cosmetic only.
- **Fix:** declare `let mut pending: Vec<&Migration> = …collect();` at `:108` and
  delete line `:115`.
- **Not auto-applied:** fails gate (c) — the shadow-to-add-`mut` pattern is a
  legitimate deliberate idiom; not for an agent to overrule.
- **Effort:** trivial · **Confidence:** low (style preference).

#### S5 — No frontend linter wired up
- **Location:** `ui/package.json` (scripts / devDependencies).
- **Intent analysis:** `CLAUDE.md` Conventions names "Prettier + ESLint", but the
  project is mid-L2 — the lint setup is most likely simply not done yet rather
  than rejected.
- **Problem:** no `lint` script and neither tool is a devDependency, so the
  convention's lint gate does not exist; Solid-specific footguns (e.g. C1) go
  uncaught.
- **Why it matters:** an `eslint-plugin-solid` rule would catch C1-class bugs
  automatically.
- **Fix:** add `eslint` + `eslint-plugin-solid` + `prettier` as devDependencies
  and a `"lint"` script — a "pending setup" task, not a defect.
- **Not auto-applied:** fails gate (d) — it is build-tooling setup, not a code
  change, and out of scope for a code-fix pass.
- **Effort:** small · **Confidence:** high.

## 4. Architectural observations

None. Every finding above is implementable without touching a locked
architectural decision.

## 5. Checked and clean

- **`cubical-core`:** `vault/mod.rs`, `vault/atomic.rs` (besides C2),
  `vault/watcher.rs`, `vault/frontmatter.rs`, `file_type/mod.rs` — reviewed, sound.
- **`cubical-index`:** `runner.rs` (besides S1/S4), `migrations.rs`, `error.rs`,
  `lib.rs` — clean; atomic migration-in-transaction logic is well tested.
- **`cubical-ast`:** `frontmatter.rs` — strict, well-tested splitter.
  `normalize.rs` skim-only (mirror code under the cross-language parity harness).
- **`cubical-app`:** `lib.rs` (Tauri shims; `expect` at `:82` is in the `run`
  entry point — allowed), `state.rs`, `api/types.rs`, `events.rs`,
  `commands/vault.rs` — reviewed; the un-batched audit writes are deliberate
  (see the P1 retraction).
- **`cubical-search` / `cubical-sync`:** L4/L7 skeleton crates — empty by design,
  nothing to review.
- **`ui/src/`:** `Editor.tsx` (Solid reactivity correct — props read lazily, no
  destructuring), `editor/cm-theme.ts`, `styles/theme.ts`, `virtualList.ts`,
  `api/ipc.ts` (besides R2). `ast/normalize.ts` skim-only (parity-harness mirror).

**Tooling baseline:** clippy / fmt clean · `tsc` clean · 121 Rust + 46 vitest
green, before and after the applied change.
