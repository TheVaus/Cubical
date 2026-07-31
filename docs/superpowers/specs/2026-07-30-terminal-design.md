# Embedded terminal — a real shell in a tab

**Date:** 2026-07-30
**Status:** **built and GUI-verified** on `feat/terminal` 2026-07-31 — see "What was built"
**Depends on:** [`2026-07-30-vault-convergence-design.md`](2026-07-30-vault-convergence-design.md) (Spec A), merged 2026-07-30

## Why

The command console (CLI Phase 3) runs Cubical verbs in-process with no shell and no PTY. That was the right call for what it was, but it cannot do the thing actually wanted: run a **real terminal** — `cd`, `cat`, `grep`, `pwd`, `touch`, `git` — and in particular run **AI CLIs** (`claude`, `codex`, local models) against the vault **without restricting their tools**.

Stated goal: *"a way to use a terminal in ways that might break the vaults without breaking the vaults."*

## The honest constraint

"All mutations route through the engine" and "run unrestricted AI CLIs" cannot both hold. When `claude` writes a file it issues an `open`/`write` syscall; nothing inside Cubical sees it. Interception would need FUSE or DYLD interposition — fragile, and contradictory to portability.

So integrity is not achieved by interception. It is achieved by **Spec A's convergence layer**, which is why Spec A ships first: it is the safety net, and shipping the hazard before the net is the wrong order. See [`foundation.md`](../../architecture/foundation.md) §2.1–2.2 for the locked rules this feature must satisfy.

## Design

### Tab kind and lifecycle

A new `{kind:"terminal"}` tab view, **not a singleton** — running `claude` for minutes while still having a shell is a basic requirement.

Each tab owns one PTY and one child process. This collides with the tabs model in ways that must be handled explicitly, exactly as console tabs already are:

- **Excluded from the keep-alive LRU** (`liveFileIds`). Evicting a terminal would kill a running process.
- **Excluded from session persistence** (`tab_sessions.json`). A dead process cannot be restored; a restored terminal tab would be a lie.
- **Closing a tab reaps its child** — `SIGTERM`, then `SIGKILL` after a grace period. Quitting the app or switching vaults reaps all children.
- **Closing a tab with a live foreground child asks first.**

### Emulator

`portable-pty` on the Rust side; **xterm.js** in the webview. The Rust side stays thin: spawn, stream bytes over a Tauri channel, forward keystrokes, propagate resize.

xterm.js rather than a hand-written emulator because `claude` and any TUI need the full VT surface — alt-screen, cursor addressing, 256-colour, mouse. Writing that is the single largest piece of work available here, and every gap shows up as a corrupted screen in exactly the case this feature exists for. It is a browser library, not a Node runtime, so it does not violate the no-Node rule.

The real cost is a heavy frontend dependency the design system does not own. Two mitigations, both required:

- **Adapter boundary.** No module outside `ui/src/terminal/` imports xterm.js. The terminal component talks to a thin adapter exposing only what is needed (write bytes, resize, focus, dispose, key handler). If xterm.js ever has to be replaced, the blast radius is one directory.
- **Theming shim, not style leakage.** xterm.js is configured with a theme object *derived from* DS tokens at mount, and re-derived on theme change. Its stylesheet is scoped to the terminal container. DS tokens stay the single source of truth for colour; xterm.js never contributes a colour of its own.

### Child environment

- **cwd:** vault root.
- **Confinement:** none. Unrestricted was the explicit ask.
- **`PATH`:** app binary dir prepended, so `cubical` resolves. This is the quiet win — the `cubical` binary already attaches to the running app over the Phase-2 Unix socket, so every console verb works inside the terminal *and hits the live engine*. Engine-routed operations are available by default; they are simply not mandatory.
- **`CUBICAL_VAULT`:** vault root path.
- **Shell:** `$SHELL`, falling back to `/bin/sh`.

### Retiring the console

The terminal subsumes the console: a real shell with `cubical` on `PATH` does everything `console_exec` did. Rather than delete working, tested code while its replacement is unproven, the console is **isolated first and removed later** — see "Sequencing" below.

### Steering AI CLIs

Interception is impossible, but *persuasion* works well on agents specifically. An agent told that `cubical rename-file` exists and that raw `mv` strands wikilinks will generally comply.

AI CLIs read a conventions file from their cwd — `CLAUDE.md` for Claude Code, `AGENTS.md` for most others. That means the file must sit at the **vault root** to function, which collides with the byte-for-byte commitment. Resolution:

- Canonical generated text lives at **`.cubical/agent-instructions.md`** — Cubical's own territory, written freely, zero footprint in the user's vault.
- On **first** terminal open, ask once: *"Create `AGENTS.md` + `CLAUDE.md` at your vault root so AI CLIs understand this vault? These are yours to edit or delete."* Default **no**.
- If accepted, the root files are a **one-line pointer** to `.cubical/agent-instructions.md` — a few bytes, and agents follow the reference. Cubical never rewrites them after creation.

The only vault-root write is therefore an explicit user choice. (An earlier version of this design put the file only in `.cubical/` and claimed it would steer agents; that was wrong — agents do not look there.)

### Gating

Opt-in core plugin `plugins.terminal_enabled`, **default off**, matching the console. Disabling closes all terminal tabs and reaps their children. This is condition (1) of `foundation.md` §2.1.

## Known platform gap

The Phase-2 socket is `#[cfg(unix)]` only. On Windows the terminal itself would work (ConPTY via `portable-pty`), but `cubical` inside it would hit the exit-2 decline, since the app holds the vault lock and there is no socket to attach to. Windows is already deferred; **recorded, not solved.**

## Known packaging gap

**`cubical` on the child `PATH` does not survive bundling.** The prepended directory is `current_exe().parent()` — under `cargo tauri dev` that is `target/debug/`, which holds both `cubical-app` and `cubical`, so the win above is real in development. A bundled `.app` ships only `cubical-app` in `Contents/MacOS/`, and `tauri.conf.json` declares no `externalBin`, so in a release build `cubical` resolves only if the user installed it separately. Fixing it is release tooling — sidecar naming with a target-triple suffix and a build step to place the CLI — not terminal work. **Recorded, not solved.**

## Sequencing

1. **Spec A lands first.** Non-negotiable — it is the safety net.
2. **Isolate the console.** Collapse its surface to a single wiring point so terminal work cannot collide with it, without deleting anything. Console code today spans `ui/src/console/`, `ui/src/api/ipc.ts`, `ui/src/core/commands.ts`, `ui/src/settings/corePlugins.ts`, `ui/src/tabs/*`, `crates/cubical-app/src/lib.rs`, and `crates/cubical-ipc/`.
3. **Build the terminal** behind its default-off toggle.
4. **Remove the console** in one commit, once the terminal is proven — not before.

## Out of scope

- Sandboxing or confining child processes (`foundation.md` §2.1 — the three conditions replace the sandbox for gateways).
- An MCP server exposing engine verbs as typed tools to AI CLIs. Genuinely attractive and a much stronger steering mechanism, but it is a whole second project and gets its own spec.
- Splits, terminal panes, or a bottom-drawer terminal. It is a tab.
- Windows socket support.

## What was built

Everything above, behind `plugins.terminal_enabled` (default off). Task-by-task state, the two integration defects found, and the settled IPC contract live in the [plan](../plans/2026-07-30-terminal.md) — not repeated here.

Three decisions worth carrying forward, because they are not obvious from the design:

- **Terminal panels mount for every open terminal tab, not just the active one.** Solid's `<Show>` would unmount an inactive tab, and unmounting closes the PTY — switching tabs would kill a running `claude`. They render into the same `display: contents | none` slot the live-editor LRU already uses.
- **A dead terminal tab cannot be restored, and nothing tries to.** T6's allowlist `isPersistableTab` excluded `terminal` for free, and `liveFileIds`' file-path predicate excludes terminals from the keep-alive LRU for free. Both are now asserted rather than assumed.
- **Consent is asked after the tab opens, not before.** The PTY is spawning either way; what the answer controls is only whether two pointer files appear at the vault root. Asking first would make a shell wait on a modal for no reason.

The console keeps working and keeps its tab. Sequencing step 4 — removing it — is now unblocked (the terminal is proven in a GUI) but deliberately still a separate commit.

## Testing

- PTY lifecycle: spawn, stream, resize, reap on tab close, reap on vault switch, reap on plugin disable.
- No orphan processes after any close path — the failure mode here is a hidden `claude` mutating the vault with no visible tab.
- Terminal tabs excluded from LRU eviction and from session persistence (mirrors the existing console `liveFileIds` suite).
- `cubical` resolves on the child `PATH` and reaches the live engine.
- Agent-instructions consent: declining writes nothing to the vault root; accepting writes the pointer files exactly once and never rewrites them.
- **Verification caveat (resolved by the user, 2026-07-31):** the terminal is vault-gated and the plain `vite` preview has no Tauri backend, so the interactive surface cannot be exercised in a non-interactive session — Rust-side PTY lifecycle and reaping are testable without the GUI and are where the process-leak risk lives. The remaining interactive surface was smoke-tested by hand in the running app and works. The caveat still applies to *future* sessions touching this code.
