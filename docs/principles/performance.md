# performance — Performance is measured, not asserted

**Rule:** Hold every change to the measured scan bar; ratchet it down, never up.

**Gate:** none yet — planned `perf`. The harness exists: `cargo run --release -p cubical-core --example scan_bench -- <fixture-dir> <note-count>`.

**Why:** "Fast enough" and "imperceptible" are adjectives, and adjectives do not fail a build. The bar is a cold scan-and-index under **13 s** at 10,000 notes and **1.5 s** at 1,000 — set at roughly 2x the observed medians so it passes today and tightens later. A number nobody can reproduce is worth no more than the adjective it replaced, which is why the harness ships with the bar.

**Exceptions:** none. A CI ceiling is not an exception but a different measurement — Tantivy is about a third of the budget and scales with core count, so CI must measure on its own runner rather than inherit the dev-machine number.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §1 (commitment 2) owns the bar, method, current medians and harness.
