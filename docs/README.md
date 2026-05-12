# Cubical — Documentation

## For subagents
Check your task brief for which layer you're on. Then:
- Layer work → `docs/layer-N-spec.md` (intent + what's already landed)
- Design question → `docs/architecture/README.md` (locked decisions)
- IPC or Tauri coupling → `docs/migration-touchpoints.md`
- Unsure → read `CLAUDE.md` first, then return here

## Start here
- `CLAUDE.md` — session primer: non-negotiables, conventions, session protocol, current state
- `docs/architecture/README.md` — locked architectural decisions, indexed by domain

## Layer specs
- `docs/layer-0-spec.md` — Bedrock (§1 = intent; §14 = what was built + deviations)
- `docs/layer-1-spec.md` — Document Model (§1 = goals; §2–§5 = sessions)
- *(layer-N-spec.md added when each layer becomes active)*

## Reference
- `docs/migration-touchpoints.md` — Tauri-coupled surfaces; read before any IPC changes
- `docs/vault-gitignore.md` — recommended `.gitignore` for user vaults

## Design specs
- `docs/superpowers/specs/` — design documents from planning sessions
- `docs/superpowers/plans/` — implementation plans
