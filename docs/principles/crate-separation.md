# crate-separation — Only `cubical-app` may depend on Tauri

**Rule:** Keep every other crate buildable and testable without the app harness.

**Gate:** `scripts/check.sh` (the workspace build and test would fail on a cycle or a stray Tauri dep) — no dedicated check yet; planned `dependency-boundary`.

**Why:** The engine holds all the logic and `cubical-app` is only the Tauri shell, which is what makes a second frontend possible at all. `cubical-cli` exists as standing proof the engine is frontend-agnostic — if the boundary rotted, the CLI would stop building. It is also the rewrite boundary: a Tauri-coupled surface is a migration cost, so they are inventoried rather than allowed to spread.

**Exceptions:** none. No crate cycles either.

**Detail:** [`../README.md`](../README.md) → Repository layout · [`../migration-touchpoints.md`](../migration-touchpoints.md) inventories the Tauri-coupled surfaces.
