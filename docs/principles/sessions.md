# sessions — Ceremony scales with the work

**Rule:** Pick the lightest process that fits, and record the *why* once, at the end.

**Gate:** `scripts/session.sh` (`start` / `end`), triggered by the Claude Code `Stop` hook. It warns; it does not block bookkeeping.

**Why:** Paying layer-scale process for a one-line fix is how a project ends up with 105 process documents describing 20 features. The archived work tree is the evidence: every feature there has a matching spec + plan pair, because they predate this rule.

| Task | Process |
|---|---|
| Trivial / mechanical (typo, rename, obvious fix) | just do it, then commit |
| Standard feature surface | **one** GitHub issue carrying Why · Design · Task graph |
| Layer / novel / architectural | issue + an `arch-review` before code |

**In-flight design lives in a GitHub issue, not a file in this tree.** That is the whole reason `docs/work/` does not exist: a document describing work in progress goes stale the moment the work changes, and nothing makes anyone notice. An issue has a state, an assignee and a close event.

**Write outcomes once, at the end — capture the *why*, not the *what*.** Record decisions including rejected alternatives, deviations from the plan, and non-obvious constraints: the things that evaporate if unwritten. Skip what git already shows — files touched, build logs, per-session test counts. A good record is closer to 5–10 lines of *why* than a 100-line narration.

**Record divergence explicitly.** When work departs from the plan written above it, note the deviation rather than leaving a superseded plan to silently contradict what shipped. This is not optional politeness: `engine-ipc.md` described the rename path in terms of two functions that were never implemented, because the plan's decomposition was copied forward and never reconciled. See [`implementation-anchors`](implementation-anchors.md).

**Smoke testing.** Run an interactive `cargo tauri dev` smoke for any change touching a rendered or interactive surface, and say in the PR that it passed. Headless or backend-only work needs none. A hot-reloaded frontend on a stale Rust binary fakes real bugs — force a full recompile before debugging anything in the Tauri layer.

**Exceptions:** A layer close that cannot run the operator smoke in its own context records the recipe and blocks the **layer tag** — not individual sessions — on a follow-up interactive pass.

**Detail:** the session contract is the prohibition list in [`../../CLAUDE.md`](../../CLAUDE.md) and the checklist in `.github/pull_request_template.md`.
