# Cubical — Documentation

This is the docs index. The session primer is [`CLAUDE.md`](../CLAUDE.md) — start there.

[`CLAUDE.md`](../CLAUDE.md) is auto-loaded every session. Every other file in this tree is loaded on demand based on the task — use the table below to decide what to read.

## What kind of question do you have?

| Question | Read |
|---|---|
| What's the session primer? Current state? | [`CLAUDE.md`](../CLAUDE.md) |
| What's locked architecturally? | [`architecture/README.md`](architecture/README.md) — split by domain |
| What's the code-style rule for X? | [`conventions.md`](conventions.md) |
| Where are we in the build order? What ships next? | [`build-order.md`](build-order.md) |
| What does this layer cover? What landed? | [`layer-0-spec.md`](layer-0-spec.md) · [`layer-1-spec.md`](layer-1-spec.md) · [`layer-2-spec.md`](layer-2-spec.md) |
| I'm touching IPC / Tauri | [`migration-touchpoints.md`](migration-touchpoints.md) |
| User wants a `.gitignore` for their vault | [`vault-gitignore.md`](vault-gitignore.md) |
| What's been explicitly cut from scope? | [`architecture/constraints.md`](architecture/constraints.md) |

## Layer status

- `layer-0-spec.md` — Bedrock (closed 2026-05-13, `l0` tag)
- `layer-1-spec.md` — Document Model (closed 2026-05-09, `l1` tag)
- `layer-2-spec.md` — Editing (closed 2026-05-22, `l2` tag)
- *(later layer specs added when each layer becomes active)*

## Other content

- [`reviews/`](reviews/) — past workflow reviews (some recommendations still actionable)
- [`superpowers/prompts/`](superpowers/prompts/) — active session prompts
- [`superpowers/plans/archive/`](superpowers/plans/archive/) — executed planning artifacts
