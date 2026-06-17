# Bug fix — "Create" from an unresolved wiki-link errors with `FileNotFound`

Small focused bug-fix session for the Cubical project. A real user flow is broken: clicking an unresolved wiki-link offers to create the target file (good), but clicking "Create" raises `file not found in vault: folder/NoteC.md` (bad). Root cause: `acceptCreateOffer` reuses `writeFileText`, which by design gates on the file already being indexed (`commands::vault::write_file_text`, `crates/cubical-app/src/commands/vault.rs:374-377` — `CubicalError::FileNotFound` is the explicit guard). No dedicated "create file" path exists. Add one and switch the caller. Do NOT start L3 Session H.2 in this session — the bug fix is the only surface.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state" block (currently points at Session H.2 as next; this bug fix lands ahead of it).
   - `docs/conventions.md` — code style.
   - `docs/migration-touchpoints.md` — Tauri IPC chokepoints.

2. Read for context (you'll come back to specific lines):
   - `crates/cubical-app/src/commands/vault.rs` — `pub async fn write_file_text` (the gate that's currently wrong for create) and the rest of the vault commands (model for the new handler).
   - `crates/cubical-app/src/lib.rs` — Tauri shim + `generate_handler!` registration pattern. The recent `get_embed` entry is the freshest precedent.
   - `crates/cubical-app/src/api/types.rs` — wire-type style (recent precedents: `GetEmbedRequest/Response`, `CreateBlockRefRequest/Response`).
   - `crates/cubical-app/src/error.rs` — `CubicalError` variants (use `InvalidRequest` for "file already exists"; `Io` for filesystem errors).
   - `crates/cubical-core/src/vault/atomic.rs` — `atomic_write(path, bytes)` is the sole write primitive (sync; call via `tokio::task::spawn_blocking`, exactly like `write_file_text` does at lines ~395-400).
   - `ui/src/App.tsx` — `acceptCreateOffer` (~line 619) is the broken caller; `handleNavigateWikilink` is what runs after a successful create.
   - `ui/src/api/ipc.ts` — IPC binding style; the recent `getEmbed` is the freshest precedent.

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` →
     `merge: L3 Session H.1 — embed content extractor + IPC` (commit `~7a08…` — verify against `git log`).
   - CLAUDE.md "Project state" reports Session H.1 done (most recent merge).

4. Baseline test counts (must match CLAUDE.md "Project state"):
   - `cargo test --workspace 2>&1 | grep "test result: ok" | head` — 289 Rust tests green (sum across crates).
   - `( cd ui && npx vitest run )` — 293 vitest green.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b bugfix-create-from-unresolved-wikilink`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `superpowers:using-superpowers` — ALWAYS, first.
- `superpowers:test-driven-development` — every behaviour change lands with a failing test first.
- `superpowers:executing-plans` (or `subagent-driven-development` if subagents are available) — works through the small plan below task-by-task.
- `superpowers:verification-before-completion` — at the end, fresh test output + an honest smoke note.
- `superpowers:finishing-a-development-branch` — ALWAYS, at the very end.

SKIP `brainstorming` and `writing-plans` — the bug fix is fully specified in STEP 2; one new IPC + one caller swap is too small for the full spec→plan→execute ceremony. Write the work inline in this prompt.

---

## STEP 2 — THE WORK

The whole session is ~4 commits. Do them in this order.

### Commit 1 — `feat(app): create_file handler — atomic empty-file create with mkdir -p`

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs` — append:

  ```rust
  // -- create_file ---------------------------------------------------------

  /// Request payload for `create_file`.
  #[derive(Debug, Clone, Deserialize)]
  pub struct CreateFileRequest {
      pub vault_id: String,
      /// Vault-relative path of the file to create. Parent directories
      /// are created on demand.
      pub path: String,
  }

  /// Response payload for `create_file`.
  #[derive(Debug, Clone, Serialize)]
  pub struct CreateFileResponse {
      /// Echo of the created path.
      pub path: String,
  }
  ```

- Modify: `crates/cubical-app/src/commands/vault.rs` — add a new handler after
  `write_file_text`. The whole point is "no gate on `files` row existence —
  the file is *new*." The watcher's `Created` event will then insert the
  `files` row + run frontmatter/links/tags/blocks refresh on its own.

  ```rust
  /// Create a new empty file at `path` (vault-relative). Used by the
  /// "create from unresolved wiki-link" UI flow. Parent directories
  /// are created as needed. The new file lands in the index via the
  /// watcher's `Created` event — this handler does NO direct DB work.
  ///
  /// Errors:
  /// - `VaultNotOpen` — unknown `vault_id`.
  /// - `InvalidRequest` — `path` already exists on disk (refuse to
  ///   silently clobber; the editor-save path is `write_file_text`).
  /// - `Io` — filesystem failure (mkdir / write).
  pub async fn create_file(
      state: &AppState,
      req: CreateFileRequest,
  ) -> Result<CreateFileResponse, CubicalError> {
      let abs_path = {
          let guard = state.vaults().read().await;
          let open = guard
              .get(&req.vault_id)
              .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
          open.vault.root().join(&req.path)
      };

      // Refuse to clobber an existing file. Use the editor-save path
      // (`write_file_text`) for updates.
      if tokio::fs::try_exists(&abs_path)
          .await
          .map_err(|e| CubicalError::Io(format!("try_exists failed: {e}")))?
      {
          return Err(CubicalError::InvalidRequest(format!(
              "file already exists: {}",
              req.path
          )));
      }

      // Create parent directories. `abs_path.parent()` is None only when
      // `abs_path` is `/` or similar — vault-relative paths always have
      // a parent, so this is defensive.
      if let Some(parent) = abs_path.parent() {
          tokio::fs::create_dir_all(parent)
              .await
              .map_err(|e| CubicalError::Io(format!("create_dir_all failed: {e}")))?;
      }

      // Atomic write of empty bytes. Pushed off the runtime, mirroring
      // `write_file_text`.
      let abs_for_write = abs_path.clone();
      tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, b""))
          .await
          .map_err(|e| CubicalError::Io(format!("write task join error: {e}")))??;

      Ok(CreateFileResponse { path: req.path })
  }
  ```

- Add to the existing `mod tests` in the same file (mirror the shape of the
  `write_file_text_*` tests already there — they use `fresh_state_with_vault`
  + write a file to disk + assert on the response). Two tests:

  1. **`create_file_writes_empty_file_with_nested_parent`** — call
     `create_file` with `path = "folder/sub/NoteC.md"`; assert the
     file exists at the absolute path with empty content, parent dirs
     exist, response echoes `path`.

  2. **`create_file_rejects_existing_path_with_invalid_request`** —
     pre-create `existing.md` on disk, call `create_file` with that
     path, assert error matches `CubicalError::InvalidRequest`.

  Run: `cargo test -p cubical-app commands::vault::tests::create_file`
  → both PASS.

- Run: `cargo clippy -p cubical-app --all-targets -- -D warnings` and
  `cargo fmt --all` → clean.

- Commit.

### Commit 2 — `feat: register create_file Tauri command + IPC binding`

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`:
  - Add `CreateFileRequest, CreateFileResponse,` to the
    `use api::types::{...}` block (alphabetical with other `Create*`).
  - Add the shim near the other vault shims:

    ```rust
    /// Tauri shim — see [`commands::vault::create_file`].
    #[tauri::command]
    async fn create_file(
        state: tauri::State<'_, AppState>,
        req: CreateFileRequest,
    ) -> Result<CreateFileResponse, CubicalError> {
        commands::vault::create_file(state.inner(), req).await
    }
    ```

  - Register in `generate_handler![...]` next to `write_file_text,`:
    `create_file,`.

- Modify: `ui/src/api/ipc.ts` — append after the `writeFileText` binding:

  ```ts
  // ---------------------------------------------------------------------------
  // create_file (new empty file at path, for the "create from unresolved
  // wiki-link" flow). The watcher inserts the files row on its own.
  // ---------------------------------------------------------------------------

  export interface CreateFileRequest {
    vault_id: string;
    /** Vault-relative path of the file to create. Parents are mkdir -p'd. */
    path: string;
  }

  export interface CreateFileResponse {
    /** Echo of the created path. */
    path: string;
  }

  /** Create a new empty file at `path`. Refuses to clobber an existing file. */
  export function createFile(
    req: CreateFileRequest,
  ): Promise<CreateFileResponse> {
    return invoke("create_file", { req });
  }
  ```

- Run: `cargo build -p cubical-app && ( cd ui && npx tsc --noEmit )`
  → both clean.

- Commit.

### Commit 3 — `fix(ui): use create_file for "create from unresolved wikilink"`

**Files:**
- Modify: `ui/src/App.tsx`:
  - Extend the `./api/ipc` import block to include `createFile,`.
  - Replace `acceptCreateOffer` (currently calls `writeFileText` with empty
    content — the broken path). Body becomes:

    ```ts
    const acceptCreateOffer = async () => {
      const offer = createOffer();
      const id = vaultId();
      if (!offer || !id) return;
      setCreateOffer(null);
      try {
        await createFile({ vault_id: id, path: offer.path });
        // The watcher's `Created` event inserts the `files` row + runs
        // frontmatter/links/tags/blocks refresh. We navigate immediately;
        // resolution will heal as the index lands.
        await handleNavigateWikilink(offer.path, null);
      } catch (e) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(message);
      }
    };
    ```

  - Verify the call site is the only user of `writeFileText` we're touching
    (autosave still uses `writeFileText` — do NOT change that).

- Run: `( cd ui && npx tsc --noEmit && npx vitest run )` → tsc clean;
  vitest unchanged (no new UI logic added beyond a one-line IPC swap).

- Commit.

### Commit 4 — `docs: record bug fix — create_file IPC + acceptCreateOffer`

**Files:**
- Modify: `docs/layer-3-spec.md` — append `### 9.13 Bug fix — create-from-
  unresolved wiki-link` after §9.12. ~6 lines: cite the symptom
  (`file not found in vault: …`), root cause (`writeFileText` gates on
  the file already being indexed by design — see `vault.rs:374-377`), fix
  (new `create_file` handler that does no DB work; the watcher's `Created`
  event handles indexing), and that the bug was a Session B-era oversight
  uncovered when hands-on smoke finally ran on the unresolved-wikilink
  surface.

- Modify: `CLAUDE.md` — rewrite (do NOT append) the Project state block
  noting the bug fix landed and final test counts (289 + 2 = 291 Rust;
  vitest still 293); set "Next: **Session H.2 — embed widget** (live-
  preview block widget consuming `getEmbed`; depth cap → styled link;
  cycle detection; unresolved placeholder)."

- Commit.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cargo test --workspace 2>&1 | grep -E "test result: FAILED|^test result: ok" | grep -v "0 passed; 0 failed" | tail` →
  Rust 291 across crates (was 289 + 2 new). If `runner::tests::schema_too_new_is_rejected` trips, it's a known parallel-run flake — re-run in isolation.
- `cargo clippy --workspace --all-targets -- -D warnings` → clean.
- `cargo fmt --all --check` → clean.
- `( cd ui && npx tsc --noEmit && npx vitest run && npm run build )` →
  tsc clean; vitest 293 unchanged; build clean.
- **Interactive smoke against `cargo tauri dev`** (this is the *exact* surface that's broken — please run it):
  1. Open a sandbox vault.
  2. In note A, type `[[folder/NoteC]]` where `folder/NoteC.md` doesn't
     exist; save. Click the resulting unresolved-style link.
  3. Confirm the "Create" offer appears.
  4. Click "Create" — confirm no error banner; confirm `folder/NoteC.md`
     appears on disk as an empty file; confirm the editor opens it; the
     wiki-link in A re-resolves (no longer dashed) within ~1s.
  5. Re-click "Create" while the file exists (unlikely UI path but worth
     proving): confirm a clean `InvalidRequest` error in the banner, not
     a panic.
  Record the result in the commit message of Commit 4 (or as a comment if
  smoke isn't possible — `verification-before-completion` requires the
  honest note).

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch
  `bugfix-create-from-unresolved-wikilink` created from `main`.
- [ ] `create_file` handler + 2 unit tests green.
- [ ] Tauri shim + `generate_handler!` registration + `ipc.ts` binding wired.
- [ ] `acceptCreateOffer` calls `createFile` (not `writeFileText`); autosave's `writeFileText` usage unchanged.
- [ ] All gates clean: `cargo test --workspace`, `clippy -D warnings`, `fmt --check`, `tsc`, `vitest`, `npm run build`.
- [ ] §9.13 written; CLAUDE.md "Project state" rewritten with the new counts and "Next: Session H.2".
- [ ] Interactive smoke recorded (or explicitly documented as deferred with the recommended smoke script above).

---

## OUT OF SCOPE (do not build in this session)

- Session H.2 (embed widget) — its own next session.
- Any change to `write_file_text`'s exists-check (it's correct for the editor-save path).
- A `create_directory` IPC, a "create note with title prompt" UI, or any
  template / boilerplate insertion. Empty file is the whole feature.
- Cleaning up other smoke debt (Session F autocomplete, Session G gesture
  / decoration / status bar, `[[#^` dropdown, `get_embed` dev-console
  invocations) — record them as still-pending in CLAUDE.md if you touch it.

---

## SESSION END PROTOCOL

1. Commit in the four logical units above (Conventional Commits). Do NOT
   skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Project default: merge
   `bugfix-create-from-unresolved-wikilink` into `main` after verifying
   green, `--no-ff` (matches every prior L3 session).
3. Report back: every DoD box's status, the final test counts, the
   smoke evidence (or honest absence), and name the next session —
   **L3 Session H.2 — embed widget**.
