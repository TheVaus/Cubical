# Cubical

Local-first Markdown PKM. Tauri + Rust + Solid/TS. Plain `.md` files are the
source of truth; no Electron, no Node runtime, no cloud in the shipped product.

## Non-negotiables

Load-bearing. Surface a conflict as an architecture change, never a code change.
Each is stated in full by its owner — these lines are the reminder, not the rule.

- `.md` files are the source of truth; derived state is rebuildable —
  [`vault.md`](docs/architecture/vault.md) §3.
- The vault is portable and self-contained. No external service opens it.
- Files survive external edits and renames while the app is closed —
  [`convergence-over-interception`](docs/principles/convergence-over-interception.md).
- Performance is measured, not asserted; ratchet down, never up —
  [`foundation.md`](docs/architecture/foundation.md) §1.
- Third-party plugin code is sandboxed (WASI/WASM; JS only as a *source*
  language). Gateway features must be opt-in, non-corrupting and auditable —
  [`native-capability-gateway`](docs/principles/native-capability-gateway.md).
- Desktop only for v1; do not preclude mobile —
  [`planned.md`](docs/architecture/planned.md).
- No file-identity UUIDs in any `.md` before sync onboarding.
- Features are composable blocks over always-on substrate —
  [`composability`](docs/principles/composability.md).

## Session contract

Prohibitions, because these are what priors override:

- Don't write comments — write docs. Don't hand-edit `generated/**`.
- Don't hand-roll a UI control before reading `design-system/INVENTORY.md`.
- Don't reach across the IPC boundary. Don't restate a fact that has an owner.
- Don't record file lists, build logs or test counts anywhere.
- Don't rewrite this primer mid-session. Don't trust `.superpowers/**` — it is
  agent scratch that nobody reviews.
- Run `scripts/graph.sh` before fanning out reads; it refuses when stale.
  Never shell `grep -r` — `ui/dist/` is a build artifact in the tree.
- Delegate search to an `explorer`; run a `verifier` before merge.
- File future work as an issue, never as doc prose. Before starting in an area,
  list its open ideas: `gh issue list --label area:<x> --label idea`.

## Where things are

| Question | Read |
|---|---|
| What rule constrains me? | [`principles/README.md`](docs/principles/README.md) |
| What's locked? | [`architecture/README.md`](docs/architecture/README.md) |
| Why is this code like this? | [`implementation/`](docs/implementation/) |
| What exists right now? | [`generated/`](docs/generated/) |
| Anything else | [`docs/README.md`](docs/README.md) |
| What's next / broken | GitHub Issues — no milestone means unscheduled |

## Commands

```bash
scripts/check.sh          # the gate. Run the script, not the pieces.
scripts/session.sh start  # graph freshness, open ideas, branch
scripts/session.sh end    # gate, drift, untouched issues
```

`scripts/check.sh | tail` reports `tail`'s exit code, not the gate's.

## Now

Docs rework: principles + gates + archive landed; `superpowers/` is gone.
An uncommitted parallel worktree holds a single-parse scan fix (issue #60).
Layer 5 is the open v1.0 cut — [`layers.md`](docs/architecture/layers.md).
