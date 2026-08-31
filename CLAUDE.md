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
- Never shell `grep -r` — `ui/dist/` is a build artifact in the tree. Use `rg`.
- Delegate search to an `explorer`; run a `verifier` before merge. A subagent
  reports; the session owning the tree commits.
- Branch off `main` first — [`branches`](docs/principles/branches.md). Don't hold
  work back waiting to be told to commit: commit each logical change as it lands
  — [`commits`](docs/principles/commits.md) — and push early. No session ends
  with uncommitted work, an unpushed branch or no PR; `session.sh end` blocks —
  [`sessions`](docs/principles/sessions.md). Never `--force`; merging is the
  operator's call.
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
| Effort too foggy to plan, or an issue not yet takeable | `/wayfinder` · `/triage` |

## Commands

```bash
scripts/check.sh          # the gate. Run the script, not the pieces.
scripts/session.sh start  # open ideas, branch, dirty tree
scripts/session.sh end    # gate, drift, untouched issues
```

`scripts/check.sh | tail` reports `tail`'s exit code, not the gate's.

## Now

Shipping installable builds is the open thread: tiers are locked in
[`distribution.md`](docs/architecture/distribution.md), the work is #97, and the
signing call is still open in #96. The repo is public and CI runs the three-OS
matrix per PR; #109 tracks turning on the protections that unlocks.
Layer 5 is the open v1.0 cut — [`layers.md`](docs/architecture/layers.md).
