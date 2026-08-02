# subagents — Delegate search and verification, keep implementation on the main thread

**Rule:** Send a subagent to explore or to verify; do the building yourself.

**Gate:** none.

**Why:** A cold agent is better than you at fan-out — sweeping many files for one answer, or reviewing work it has no stake in — and worse at anything depending on accumulated context. Delegating implementation means the agent re-derives context you already hold, then hands back code you must read fully anyway. Delegating *verification* is the opposite trade: not sharing your context is exactly what makes the review worth having, because an agent that did not write the code will not defend it.

**Exceptions:** Implementation may be delegated when tasks are genuinely parallel **and** disjoint — separate files, no shared state, no ordering between them. Anything a subagent reports is a claim, not a result: verify load-bearing findings yourself before acting, and never repeat a subagent's "it's clean" without checking. Reports belong in the PR, not in gitignored scratch.

**Detail:** none yet — agent definitions live in `.claude/agents/` once they exist.
