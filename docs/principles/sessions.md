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

**`main` is protected server-side.** A repository ruleset on the default branch refuses a direct push, a force-push and a deletion, and holds a pull request unmergeable until the CI checks it names report green. It requires no approving review, so a solo maintainer is not locked out of merging their own work — the gate is the build, not a second person. The ruleset names those checks *by job name*, which makes the job names in [`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml) load-bearing: rename one and the ruleset waits forever for a check that will never report, so rename and ruleset have to move together. Separately, **secret-scanning push protection** refuses any push carrying a recognised credential, on every branch.

`scripts/hooks/pre-push` stays worth installing (`scripts/hooks/install.sh`) — it fails in a second on your own machine instead of after a round trip — but it is now the courtesy, not the control: `--no-verify` skips it and it exists only where someone installed it.

**Write outcomes once, at the end — capture the *why*, not the *what*.** Record decisions including rejected alternatives, deviations from the plan, and non-obvious constraints: the things that evaporate if unwritten. Skip what git already shows — files touched, build logs, per-session test counts. A good record is closer to 5–10 lines of *why* than a 100-line narration.

**Record divergence explicitly.** When work departs from the plan written above it, note the deviation rather than leaving a superseded plan to silently contradict what shipped. This is not optional politeness: `engine-ipc.md` described the rename path in terms of two functions that were never implemented, because the plan's decomposition was copied forward and never reconciled. See [`implementation-anchors`](implementation-anchors.md).

**Smoke testing.** Run an interactive `cargo tauri dev` smoke for any change touching a rendered or interactive surface, and say in the PR that it passed. Headless or backend-only work needs none. A hot-reloaded frontend on a stale Rust binary fakes real bugs — force a full recompile before debugging anything in the Tauri layer.

**Exceptions:** A layer close that cannot run the operator smoke in its own context records the recipe and blocks the **layer tag** — not individual sessions — on a follow-up interactive pass.

**Detail:** the session contract is the prohibition list in [`../../CLAUDE.md`](../../CLAUDE.md) and the checklist in `.github/pull_request_template.md`.
