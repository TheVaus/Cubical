# subagents — Delegate search and verification, keep implementation on the main thread

**Rule:** Send a subagent to explore or to verify; do the building yourself.

**Gate:** none.

**Why:** A cold agent is better than you at fan-out — sweeping many files for one answer, or reviewing work it has no stake in — and worse at anything depending on accumulated context. Delegating implementation means the agent re-derives context you already hold, then hands back code you must read fully anyway. Delegating *verification* is the opposite trade: not sharing your context is exactly what makes the review worth having, because an agent that did not write the code will not defend it.

**Exceptions:** Implementation may be delegated when tasks are genuinely parallel **and** disjoint — separate files, no shared state, no ordering between them. Anything a subagent reports is a claim, not a result: verify load-bearing findings yourself before acting, and never repeat a subagent's "it's clean" without checking. Reports belong in the PR, not in gitignored scratch.

**The three types**, defined in `.claude/agents/` so a cold agent loads them automatically:

| Agent | Tools | Checks against |
|---|---|---|
| `explorer` | read-only | nothing — it answers questions. A read-only tool set means it *cannot* violate a write rule, so it does not need to know them. |
| `implementer` | full | `principles/README.md`, the session contract, and the relevant `implementation/` file |
| `verifier` | read-only + test execution | `principles/` and the issue's acceptance criteria — **not** the author's intent |

**A subagent does not commit; the session that owns the working tree does.** This is the one place the standing commit authority in [`commits.md`](commits.md) stops, and the reason is concurrency, not approval: [`branches.md`](branches.md) rules out worktrees, so parallel `implementer`s write into the *same* checkout. An agent that stages on its own judgement there sweeps up another agent's half-written files under its own commit message. A subagent therefore reports what it changed and leaves the commit to its caller, who is the only party that can see the whole tree. A lone subagent working a tree nobody else is touching may commit if its caller says so.

A verifier pass is standard before merge on non-trivial changes, and its report goes in a PR comment. These were deployed *after* the principles and the gates existed, deliberately: before that, agents multiply drift rather than reduce it, because there is nothing for them to check against.

**Detail:** `.claude/agents/`.
