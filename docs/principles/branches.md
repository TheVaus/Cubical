# branches — Branch per stream of work, one session at a time

**Rule:** Branch off `main` before the first change, and never graft unrelated work onto an active feature branch.

**Gate:** `scripts/session.sh` (`start` warns on `main`; `end` blocks).

**Why:** A multi-session feature shares one branch, but a docs pass or an orthogonal fix gets its own — grafting them together makes the PR unreviewable and couples two things that should merge independently. One session works in one working directory: two sessions sharing a tree race each other's commits and each other's build artifacts. A single session therefore branches in the main checkout rather than reaching for a second working tree.

**The branch is created before the work, not discovered after it.** Every session ends by opening a pull request ([`sessions.md`](sessions.md) owns that obligation), and a PR needs a branch that existed from the first commit. Branching at the end instead means either committing on `main` first — which the server-side ruleset refuses outright — or rewriting history to move commits off it, which the standing authority in [`commits.md`](commits.md) explicitly does not cover. So the branch is the first act of a session that will change anything, not a step remembered at the end.

**Exceptions:** concurrent sessions. When a session is already working in the main checkout, a second one takes a `git worktree` instead of joining it — that is what keeps the two from racing, so it serves this rule rather than bending it. One session owns the main checkout; every other session owns a worktree, and each still branches off `main` and ends in its own PR. A worktree is removed once its branch merges. Note that large structural work (mass file relocation) must wait for outstanding feature branches to merge first — resolving a moved-path conflict against an open branch means fixing conflicts on paths that no longer exist.

**Detail:** [`sessions.md`](sessions.md) for how much process a branch warrants.
