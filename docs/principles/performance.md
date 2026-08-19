# performance — Performance is measured, not asserted

**Rule:** Hold every change to the measured bars; ratchet them down, never up.

**Gate:** `perf`, opt-in with `CUBICAL_PERF=1` because a 10k-note cold scan takes minutes and a gate too slow to run is a gate nobody runs. Each bar is a named benchmark in `scripts/perf-budget.json`, which declares the example to run, how to drive it and what it may cost.

**Why:** "Fast enough" and "imperceptible" are adjectives, and adjectives do not fail a build. Every bar is a wall-clock median over a deterministic fixture, set at roughly 2x the observed median so it passes today and tightens later — **the numbers, the method and the current medians are owned by [`../architecture/foundation.md`](../architecture/foundation.md) §1 (commitment 2)**, with the machine-readable copy in `scripts/perf-budget.json`. A number nobody can reproduce is worth no more than the adjective it replaced, which is why the harness ships with the bar.

**Exceptions:** none. A CI ceiling is not an exception but a different measurement — the bars are wall-clock and core-sensitive (Tantivy is about a third of the scan budget and scales with core count), so CI must measure on its own runner rather than inherit the dev-machine number. Below its declared machine class the gate refuses to assert rather than scaling by a guess.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §1 (commitment 2) owns the bar, method, current medians and harness.
