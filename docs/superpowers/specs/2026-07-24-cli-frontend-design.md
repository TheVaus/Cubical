# CLI Frontend — Design

**Date:** 2026-07-24
**Status:** Phase 1 approved for build; Phases 2–3 specced, deferred.
**Branch:** `feat/cli-frontend`

## Goal

A `cubical` terminal frontend that can perform every mutating action the GUI can —
create/edit files and folders, rename, delete, change settings — routed through the
**same engine command functions** the Tauri app uses, so the app's bookkeeping
(index, link graph, rename-durability journal, search) stays correct. Usable from an
external terminal, and (Phase 3) from a panel inside the app.

## The invariant

> **One backend owns a vault at a time; every frontend attaches to it.**

This single rule delivers both properties the user asked for: *won't collide* (one
writer → one index, one journal) and *always up to date* (one live state, broadcast to
whoever is attached). "Exactly the same backend logic" is already true today — the
engine command functions (`create_file`, `rename_file`, `set_setting`, …) are the sole
choke point; `cubical-app` is a frontend that also *hosts* the engine in-process. The
open question this design answers is only **who hosts the live state and how a second
frontend attaches**.

## Chosen architecture — Option A (app-hosted backend)

- **App running:** it owns the vault and (Phase 2) publishes a local socket to its
  in-process engine; the CLI attaches → live, first-class, identical to a UI click.
- **App closed:** the CLI takes an exclusive vault lock and runs the command against a
  one-shot engine; the app reconciles on next open.

Rejected: a standalone headless daemon (Option B). It is the purest form of the
invariant (GUI and CLI both pure clients) but requires rewriting the shipped app's IPC
to become a socket client and taking on daemon lifecycle. Option A reaches the same
guarantee with no change to the app's working in-process calls, and the socket boundary
keeps Option B reachable later without the CLI noticing.

## The ownership lock — the one new primitive

A `vault_lock` module in `cubical-engine`, so **both** frontends participate
automatically (the GUI taking the lock is what lets the CLI detect it).

- **Location:** OS runtime/cache dir, **not** inside `.cubical/`. A socket path or PID
  advertised in a Dropbox-synced `.cubical/` file would be poison on another machine.
  Mirrors the `recent_vaults.json` precedent (machine-local state → OS dir). The dir is
  overridable via `CUBICAL_RUNTIME_DIR` (used by tests for hermeticity, and available to
  the CLI).
- **Filename:** keyed by a hash of the vault's canonicalized path (`<hash>.lock`).
- **Enforcement:** an **OS advisory exclusive lock** (`fs4::FileExt::try_lock_exclusive`)
  held for the owner's process lifetime — *not* PID-liveness polling. The OS releases it
  automatically when the holder exits, **including on crash**, so a crashed owner never
  wedges the vault. The lockfile's JSON payload (`pid`, canonical path,
  `socket_path: Option<String>`) is purely informational — for the "who owns it" message
  and (Phase 2) the socket to attach to.
- **Lifecycle:** acquired inside `open_vault`, guard stored on `OpenVault`, released
  inside `close_vault` (guard drop). The existing in-process
  `find_open_vault_by_canonical_path` stays as the fast path; the lockfile is its
  cross-process extension.
- **New error:** `CubicalError::VaultLocked { pid, socket_path }` returned by
  `open_vault` when the exclusive lock is already held by another process.

## Phase 1 — command surface & lifecycle

Every command is a thin `clap` wrapper over an **existing** engine function — no new
engine logic beyond the lock:

| CLI command | Engine fn | Request |
|---|---|---|
| `new note [--at <path>] [--in <parent>]` | `create_file_at_path` / `create_file` | `CreateFileAtPathRequest` / `CreateFileRequest` |
| `new folder [--in <parent>]` | `create_folder` | `CreateFolderRequest` |
| `write <path>` (body ← stdin) | `write_file_text` | `WriteFileTextRequest` (no `expected_seen_hash` → unconditional) |
| `rename <from> <to>` | `rename_file` / `rename_folder` | `RenameFileRequest` / `RenameFolderRequest` |
| `rm <path>` (→ OS trash) | `delete_path` | `DeletePathRequest` |
| `set <key> <json-value>` | `set_setting` | `SetSettingRequest` |
| `get <key>` | `get_setting` | `GetSettingRequest` |
| `undo-rename <op-id>` | `undo_rename` | `UndoRenameRequest` |
| `list` / `resolve <target>` / `backlinks <path>` | existing reads | — |

`rename` picks file vs folder by whether `<from>` resolves to a tracked file or a
directory. `set`'s value is parsed as JSON (falling back to a JSON string on parse
failure, so `set foo bar` works).

**Every invocation lifecycle:**
`open_vault` (acquires lock) → `wait_for_scan` → run the one command →
**`close_vault`** → exit. `close_vault` already runs `flush_at_close`, which flushes
pending referrer rewrites — this is what guarantees a rename's link-rewrites land before
the one-shot process dies. On any command error, still call `close_vault` before exiting
non-zero (release the lock, flush what's done).

## Phase 1 — behavior & UX

- **Vault free:** acquire lock, run, reconcile-on-next-open. Full Tier A.
- **App owns the vault** (`open_vault` → `VaultLocked`): decline cleanly —
  `"Cubical has this vault open. Live routing arrives in Phase 2."` — **exit code 2**.
  Never a second writer. Phase 2 flips this branch from *decline* to *attach*. Note this
  decline is coarse in Phase 1: it covers read commands too, because `open_vault` always
  runs a scan that writes the index, so even a "read" is not a safe concurrent op. Phase
  2 makes reads and writes both work live via the socket.
- **Output:** human-readable by default; `--json` on every command emits the engine
  response struct as JSON for scripting.
- **Exit codes:** `0` ok, `1` command error, `2` vault owned by the app.
- **Global `--vault <path>`** stays (defaults to `.`).
- **One command per invocation** (no REPL). A REPL belongs in Phase 2, over the
  persistent socket connection.

## Phases 2 & 3 — specced, not built now

- **Phase 2:** the app fills `socket_path` in the lock and runs a Unix-domain-socket
  server over the *same* command dispatch; the CLI's decline branch becomes "connect &
  route through the running engine" → live Tier B, `TauriEventSink` fires, UI updates. A
  shared dispatch layer so the local and socket paths call identical code.
- **Phase 3:** an embedded terminal panel in the app running the same `cubical` binary
  against the socket (subsumes the deferred "terminal" backlog item).

## Testing

- **Lock unit tests** (engine): acquire succeeds on a free vault; a second acquire on the
  same canonical path fails with `VaultLocked`; releasing (drop) lets a subsequent
  acquire succeed; a different vault path is independent; `CUBICAL_RUNTIME_DIR` override
  is honored.
- **Lifecycle test:** `open_vault` on an already-locked path returns `VaultLocked`;
  `open_vault`→`close_vault`→`open_vault` on the same path succeeds twice (release works).
- **CLI integration:** drive the binary against a temp vault for the core verbs
  (new note, write, rename with a referrer, rm, set/get) and assert both the filesystem
  effect and, for rename, that referrer links were rewritten (close-flush landed).
- Full gate: `scripts/check.sh`.

## Docs

- Durable rationale (lock mechanism, ownership invariant, Phase-2 socket boundary) →
  `docs/implementation/engine-ipc.md` → "Cross-process vault ownership lock".
- "What was built" recorded below; Project state block in `CLAUDE.md` rewritten.

## What was built (Phase 1 — 2026-07-24)

- **`cubical-engine::vault_lock`** — OS advisory-lock ownership primitive (`fs4` +
  `dirs`, SHA-256 path key, `CUBICAL_RUNTIME_DIR` override). 6 unit tests.
- **`CubicalError::VaultLocked { pid, socket_path }`**; `OpenVault.lock_guard`
  field (defaulted `None`, so the 16 `OpenVault::new` callers were untouched).
- **`open_vault` acquires the lock before `Vault::open`; `close_vault` releases it.**
  Both frontends now participate (the GUI takes the lock too). 1 integration test.
- **`cubical` CLI** rebuilt from the read-only PoC into a write-capable frontend:
  `list`, `resolve`, `backlinks`, `new note|folder`, `write` (stdin), `rename`
  (file/folder auto-detect), `rm`, `set`, `get`, `undo-rename`; `--json` global;
  lifecycle opens→scan→dispatch→**close (flushes referrer rewrites)**; declines
  with **exit 2** when the app owns the vault. 7 integration tests (incl. the
  referrer-rewrite proving close-flush lands, and the exit-2 decline).
- Gate green (`scripts/check.sh`), modulo the pre-existing `cubical-core` watcher
  flake.

**Not built (Phase 2/3, deferred):** the socket server + CLI attach, and the
in-app terminal panel. The `socket_path` payload field and the CLI's decline
branch are the seams they plug into.
