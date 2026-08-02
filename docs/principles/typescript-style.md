# typescript-style — Strict mode, no `any`, Solid idioms

**Rule:** Keep `tsc --noEmit` clean and never reach for `any`.

**Gate:** `scripts/check.sh` — runs `tsc --noEmit` for both `ui/` and `design-system/`. Prettier and ESLint are conventions here, **not** in the gate.

**Why:** The typed IPC surface is only worth having if the frontend is actually strict — one `any` at the boundary and a mistyped setting key silently reads `undefined` instead of failing to compile. Solid idioms matter for the performance bar: signals for fine-grained state, stores for structured state, `createResource` for async Tauri data. Reaching for a React habit (effect-driven re-render) throws away the reason Solid was chosen.

**Exceptions:** none.

**Detail:** [`../implementation/frontend.md`](../implementation/frontend.md).
