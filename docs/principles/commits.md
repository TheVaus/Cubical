# commits — Conventional Commits, one logical change each

**Rule:** Commit each logical change as soon as it stands on its own — without being asked — and update the owning doc in the same commit.

**Gate:** none.

**Why:** Conventional Commits (`feat:`, `fix:`, `refactor:`, …) keep the history greppable and make it obvious when a change is larger than its message claims. The same-commit doc rule is what stops documentation drift at the source: because rationale is banned from the code, a change that needs explaining has nowhere to put it except the owning doc, and deferring that to "later" is how the explanation is lost.

**Committing is the agent's call.** An agent here holds standing authority to stage and commit on its own judgement rather than pausing to ask. Waiting for a human "go ahead" collapses a session into one end-of-session commit spanning six concerns — exactly the shape this rule exists to prevent, and unbisectable afterwards. On a branch a commit is cheap and reversible; a history that was never structured cannot be recovered.

The judgement that stays with the agent is *when* a change stands on its own: it builds, its owning doc moved with it, and one Conventional Commit subject describes all of it without an "and". If a subject needs an "and", it is two commits.

**The session-end sweep does not move that judgement.** The check [`sessions.md`](sessions.md) imposes reads the end state only, so one commit spanning six concerns passes it and is still wrong. The sweep is a backstop for what was genuinely in flight when the work stopped, never the moment commits are supposed to happen. Committing as each change lands is what makes it find nothing to do.

**A commit is not a claim that the gate is green.** Intermediate commits are working state; running `scripts/check.sh` per commit would cost minutes each time and train people to skip it. The green run is owed before the PR leaves draft, not when it is opened — [`tests`](tests.md) owns that bar, [`sessions.md`](sessions.md) the push and PR flow.

**Standing authority does not extend to rewriting or bypassing.** Never commit on `main` — [`branches.md`](branches.md) owns why the branch is cut first — never `--force`, never rewrite pushed history, never `--no-verify`. Those destroy work rather than record it, so they remain a deliberate act the operator asks for. Nor does it extend to a parallel `implementer` — see [`subagents.md`](subagents.md).

**Exceptions:** Layer transitions also get a tag (`l0`, `l1`, …); structural-fix sessions use a descriptive suffix (`l4a-fix`). A toolchain bump goes in its own commit so the clippy gate re-validates against it alone.

**Detail:** [`sessions.md`](sessions.md) for when a commit needs a doc alongside it, and for the push, the PR and what a session owes at its end.
