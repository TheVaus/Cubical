# single-owner-facts — Every fact has exactly one owner

**Rule:** Link to the doc that owns a fact; never restate it.

**Gate:** `scripts/check_docs.py` — drives off the `ownership` data block in [`../README.md`](../README.md).

**Why:** A restated fact is a fact with two update sites, and the second one is never updated. This is not theoretical here: `prd.md` restated eight owned sections for a month without anything noticing, because the old checker hardcoded three string guards instead of reading the ownership table. Every copy is a future contradiction with a date on it.

The rule is also what makes the primer small. `CLAUDE.md` auto-loads every session, so anything restated there is paid for on every task, forever.

**Exceptions:** `docs/archive/**` is frozen and exempt — an archived doc is a record of what was believed at the time, so "correcting" it would destroy the thing it exists to preserve. Generated artifacts are exempt as *sources* (they are the owner), never as copies.

**Known limit — read this before trusting a green gate:** the checker detects *duplication*, not *contradiction*. It finds the same fact stated twice; it cannot find two statements that are each internally consistent and mutually incompatible. The rustdoc mandate that triggered this rework is the worked example: one doc required rustdoc on public items while another banned all doc-comments, and the two halves shared no detectable pattern. The only real mitigation is surface-area reduction — fewer docs, fewer words, fewer places a contradiction can hide.

**Detail:** [`../README.md`](../README.md) → Doc discipline, and the `ownership` block it renders.
