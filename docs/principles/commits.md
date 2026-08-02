# commits — Conventional Commits, one logical change each

**Rule:** One logical change per commit, and update the owning doc in the same commit.

**Gate:** none.

**Why:** Conventional Commits (`feat:`, `fix:`, `refactor:`, …) keep the history greppable and make it obvious when a change is larger than its message claims. The same-commit doc rule is what stops documentation drift at the source: because rationale is banned from the code, a change that needs explaining has nowhere to put it except the owning doc, and deferring that to "later" is how the explanation is lost.

**Exceptions:** Layer transitions also get a tag (`l0`, `l1`, …); structural-fix sessions use a descriptive suffix (`l4a-fix`). A toolchain bump goes in its own commit so the clippy gate re-validates against it alone.

**Detail:** [`sessions.md`](sessions.md) for when a commit needs a doc alongside it.
