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

## The issue tracker is the work surface

Templates live in `.github/ISSUE_TEMPLATE/` and are the canonical shape of each kind: `feature` (Why · Design · Task graph · Acceptance criteria), `bug`, `idea`, `perf-debt`, `arch-review`.

**A milestone means scheduled. Only `v1.0` exists.** An issue with **no milestone is the record**, not a backlog item awaiting triage, and nothing should ever sweep, close or "groom" it for age. That is the whole point: work that was once a numbered ladder now carries *what* and never *when*, so nothing implies an order nobody committed to.

Labels carry the rest:

| Label | Means |
|---|---|
| `idea` | Unscheduled. What, never when. No milestone, ever. |
| `gate` · `principle` · `generated` | Touches enforcement, a rule, or a generated artifact |
| `correctness` | A doc or claim that does not match the code |
| `flake` | Intermittently failing test |
| `blocked` | Paired with a `Blocked by #N` line; remove when the blocker closes |
| `perf` · `parked` | Measured debt; shipped-but-disabled |
| `area:*` | editor · index · search · ui · plugins · sync · cli · docs |

Use GitHub's own features rather than prose imitations of them: **native sub-issues** for decomposition, an explicit `Blocked by #N` plus the `blocked` label for dependencies, milestones for scheduling. A checklist item that is really its own piece of work is a sub-issue.

**Dependency alerts are never mirrored into issues** — they are already alerts. Open an issue only when *clearing* one is its own piece of work (an API migration, an index rebuild), and describe that work rather than the alert. Alert IDs are not issue numbers and must not be written as `#N`.

## Pushing and opening the PR

**Push and open the PR on your own judgement, without being asked.** The standing authority that [`commits.md`](commits.md) grants over committing covers `git push -u origin <branch>` and `gh pr create` too. Push as soon as there is work worth backing up or a reason for someone to see it; open the PR once `scripts/check.sh` has run to completion green and every box in the template is one you can honestly tick. A feature branch is not a publication — it is off `main`, CI gates it, and nothing downstream consumes it — so holding it back buys no safety and costs the review surface.

**Push early rather than at the end.** An unpushed branch is one machine away from being lost work, and a PR opened only at the end is a PR nobody got to shape. Open it as a draft when the gate is not green yet, and say in the body what is still missing.

**What still waits for the operator:** merging to `main`, force-pushing or rewriting pushed history, deleting branches, and anything that reaches outside this repo. Those are irreversible or outward-facing, which is a different question from whether the work is ready — and readiness is the only question an agent is being trusted to answer here.

**`main` is protected by a client-side hook only.** The repo is private on a free plan, so GitHub branch protection and rulesets are unavailable. `scripts/hooks/pre-push` refuses a direct push to `main`; CI runs on pushes to `main` but reports after the fact and cannot refuse. Treat the PR flow as the real gate and the hook as the reminder — install it with `scripts/hooks/install.sh`.

**Write outcomes once, at the end — capture the *why*, not the *what*.** Record decisions including rejected alternatives, deviations from the plan, and non-obvious constraints: the things that evaporate if unwritten. Skip what git already shows — files touched, build logs, per-session test counts. A good record is closer to 5–10 lines of *why* than a 100-line narration.

**Record divergence explicitly.** When work departs from the plan written above it, note the deviation rather than leaving a superseded plan to silently contradict what shipped. This is not optional politeness: `engine-ipc.md` described the rename path in terms of two functions that were never implemented, because the plan's decomposition was copied forward and never reconciled. See [`implementation-anchors`](implementation-anchors.md).

**Smoke testing.** Run an interactive `cargo tauri dev` smoke for any change touching a rendered or interactive surface, and say in the PR that it passed. Headless or backend-only work needs none. A hot-reloaded frontend on a stale Rust binary fakes real bugs — force a full recompile before debugging anything in the Tauri layer.

**Exceptions:** A layer close that cannot run the operator smoke in its own context records the recipe and blocks the **layer tag** — not individual sessions — on a follow-up interactive pass.

**Detail:** the session contract is the prohibition list in [`../../CLAUDE.md`](../../CLAUDE.md) and the checklist in `.github/pull_request_template.md`.
