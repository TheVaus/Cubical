# sessions — Ceremony scales with the work

**Rule:** Pick the lightest process that fits, record the *why* once at the end, and never end a session without a commit, a push and an open PR.

**Gate:** `scripts/session.sh` (`start` / `end`), triggered by the Claude Code `Stop` hook. `end` blocks on a red gate, on generated-artifact drift, and on a session that is not committed, pushed and on an open PR. Bookkeeping — unticked issues, an unmoved doc — only warns.

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
| `area:*` | editor · index · search · ui · plugins · sync · cli · docs · viewers · dist |
| `needs-triage` · `needs-info` | Triage started but unfinished; blocked on an answer only you can give |
| `ready-for-agent` · `ready-for-human` | Ripe: a brief is attached, and the second says what stops an agent taking it |
| `wontfix` | Closed with the reason recorded — in [`../architecture/constraints.md`](../architecture/constraints.md) when it was rejected rather than already built |
| `wayfinder:map` · `wayfinder:*` | A map issue and its decision tickets, for an effort too foggy to plan in one session |

Use GitHub's own features rather than prose imitations of them: **native sub-issues** for decomposition, an explicit `Blocked by #N` plus the `blocked` label for dependencies, milestones for scheduling. A checklist item that is really its own piece of work is a sub-issue.

**Two skills drive this tracker, and neither of them grooms it.** `/triage`
ripens a named issue until it is takeable cold; `/wayfinder` charts an effort too
big for one session as a map of decision tickets. Both read this file for the
vocabulary above rather than carrying their own, which is why the state labels
live in this table and not in the skills. The absence of a state label is the
untriaged state and is not a defect: nothing sweeps, closes or relabels an issue
for age, and that holds for a skill exactly as it holds for a session.

**Dependency alerts are never mirrored into issues** — they are already alerts. Open an issue only when *clearing* one is its own piece of work (an API migration, an index rebuild), and describe that work rather than the alert. Alert IDs are not issue numbers and must not be written as `#N`.

## Pushing, opening the PR, and ending the session

**A session that changed anything ends committed, pushed, and on an open pull request. All three, every time.** Draft if the gate is not green. `scripts/session.sh end` checks exactly that and blocks when it is not true.

Two scoping limits, both deliberate. A session that changed nothing — a question answered, a codebase read — owes nothing and exits instantly; the check looks for a dirty tree or commits ahead of `main` and skips when it finds neither. And "session" means the one that owns the working tree: a subagent reports, and its caller is the one this rule binds ([`subagents.md`](subagents.md)).

**This one is a floor, which is why it gets a gate and not a paragraph.** Work left only in the working tree is unrecoverable: the next session inherits a dirty tree it cannot attribute, and the operator has no surface to review on. The failure is silent.

**A floor is not a schedule.** Ending with a single commit satisfies the gate and still violates [`commits.md`](commits.md), which owns cadence: each logical change is committed as it lands, and the end check is a backstop for whatever was left over. A gate counting only the end state cannot tell a well-structured branch from a dump; that judgement stays with the agent.

**Push and open the PR on your own judgement, without being asked.** The standing authority in [`commits.md`](commits.md) covers `git push -u origin <branch>` and `gh pr create` too. A feature branch is not a publication — it is off `main`, CI gates it, nothing downstream consumes it — so holding it back buys no safety and costs the review surface, while an unpushed branch is one machine away from being lost work. Open it as a draft as soon as there is something to look at, saying in the body what is missing; mark it ready once `scripts/check.sh` has run to completion green and every box in the template is one you can honestly tick.

**What still waits for the operator:** merging to `main`, force-pushing or rewriting pushed history, deleting branches, and anything reaching outside this repo. Those are irreversible or outward-facing, which is a different question from whether the work is ready — and readiness is the only question an agent is trusted to answer here.

**Nothing enforces that list where you work.** The protection on `main` is scoped to the default branch, so on a feature branch a force-push, a rewritten history and a deletion are all accepted without complaint. There the rule above is the only control, and it holds because the agent honours it.

**`main` is protected server-side.** A repository ruleset refuses a direct push, a force-push and a deletion, and holds a pull request unmergeable until the CI checks it names report green. It requires no approving review, so a solo maintainer is not locked out of merging their own work — the gate is the build, not a second person. The ruleset names those checks *by job name*, which makes the job names in [`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml) load-bearing: rename one and the ruleset waits forever for a check that will never report. Separately, **secret-scanning push protection** refuses any push carrying a recognised credential, on every branch.

`scripts/hooks/pre-push` stays worth installing (`scripts/hooks/install.sh`) — it fails in a second locally instead of after a round trip — but it is the courtesy, not the control: `--no-verify` skips it, and it exists only where someone installed it.

**Write outcomes once, at the end — capture the *why*, not the *what*.** Decisions including rejected alternatives, deviations from the plan, and non-obvious constraints: the things that evaporate if unwritten. Skip what git already shows. A good record is closer to 5–10 lines of *why* than a 100-line narration.

**Record divergence explicitly.** When work departs from the plan above it, note the deviation rather than leaving a superseded plan to silently contradict what shipped. Not optional politeness: `engine-ipc.md` described the rename path in terms of two functions that were never implemented, because the plan's decomposition was copied forward and never reconciled. See [`implementation-anchors`](implementation-anchors.md).

**Smoke testing.** Run an interactive `cargo tauri dev` smoke for any change touching a rendered or interactive surface, and say in the PR that it passed. Headless or backend-only work needs none. A hot-reloaded frontend on a stale Rust binary fakes real bugs — force a full recompile before debugging anything in the Tauri layer.

**Exceptions:** A layer close that cannot run the operator smoke in its own context records the recipe and blocks the **layer tag** — not individual sessions — on a follow-up interactive pass.

**Detail:** the session contract is the prohibition list in [`../../CLAUDE.md`](../../CLAUDE.md) and the checklist in `.github/pull_request_template.md`.
