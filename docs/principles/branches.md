# branches — Branch per stream of work, one session at a time

**Rule:** Never graft unrelated work onto an active feature branch.

**Gate:** none.

**Why:** A multi-session feature shares one branch, but a docs pass or an orthogonal fix gets its own — grafting them together makes the PR unreviewable and couples two things that should merge independently. The checkout is a single working directory with **no worktrees**: two sessions at once share one tree and race each other's commits. If isolated parallel work is genuinely needed it still uses a branch in this same checkout, not a second working tree.

**Exceptions:** none. Note that large structural work (mass file relocation) must wait for outstanding feature branches to merge first — resolving a moved-path conflict against an open branch means fixing conflicts on paths that no longer exist.

**Detail:** [`../conventions.md`](../conventions.md) → Branches.
