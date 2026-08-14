# commits — Conventional Commits, one logical change each

**Rule:** Commit each logical change as soon as it stands on its own — without being asked — and update the owning doc in the same commit.

**Gate:** none.

**Why:** Conventional Commits (`feat:`, `fix:`, `refactor:`, …) keep the history greppable and make it obvious when a change is larger than its message claims. The same-commit doc rule is what stops documentation drift at the source: because rationale is banned from the code, a change that needs explaining has nowhere to put it except the owning doc, and deferring that to "later" is how the explanation is lost.

**Committing is the agent's call.** An agent working in this repo holds standing authority to stage and commit, and exercises it on its own judgement rather than pausing to ask. The default it overrides — wait for a human "go ahead" — collapses a session into one end-of-session commit spanning six concerns, which is exactly the shape the one-logical-change rule exists to prevent, and it is unbisectable afterwards. On a branch a commit is cheap and reversible; a history that was never structured cannot be recovered.

The judgement that stays with the agent is *when* a change stands on its own: it builds, its owning doc moved with it, and one Conventional Commit subject describes all of it without an "and". If a subject needs an "and", it is two commits.

**A commit is not a claim that the gate is green.** Intermediate commits on a branch are working state, and running `scripts/check.sh` per commit would cost minutes each time and train people to skip it. The green run is owed at the PR — [`tests`](tests.md) owns that bar, and [`sessions.md`](sessions.md) owns the push and PR flow.

**Standing authority does not extend to rewriting or bypassing.** Never commit on `main`, never `--force`, never rewrite pushed history, never `--no-verify`. Those destroy work rather than record it, so they remain a deliberate act the operator asks for. Nor does it extend to a parallel `implementer` — see [`subagents.md`](subagents.md).

**Exceptions:** Layer transitions also get a tag (`l0`, `l1`, …); structural-fix sessions use a descriptive suffix (`l4a-fix`). A toolchain bump goes in its own commit so the clippy gate re-validates against it alone.

**Detail:** [`sessions.md`](sessions.md) for when a commit needs a doc alongside it, and for pushing and opening the PR.
