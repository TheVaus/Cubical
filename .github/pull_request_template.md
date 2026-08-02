<!-- The checklist below is the session contract. Every box is a claim you are
     making. Tick it because you checked, not because it is probably fine. -->

## What changed

<!-- One paragraph. The *why*, not the file list — git already has the file list. -->

Closes #

## Contract

- [ ] **Gate green.** `scripts/check.sh` run to completion, exit code captured.
      (`./scripts/check.sh | tail` reports `tail`'s status, not the gate's.)
      If the known `cubical-core` watcher flake aborted it, the remaining crates
      were re-run explicitly — say so below.
- [ ] **GUI smoke** run for any change to a rendered or interactive surface, or
      **N/A** because nothing rendered changed.
- [ ] **Owning doc updated in the same commit** as the change it explains.
      Source files carry no explanatory comments — the rationale went to
      `docs/implementation/` or `docs/architecture/`.
- [ ] **No fact restated that already has an owner.** New facts got an owner row
      in the `ownership` block in `docs/README.md`.
- [ ] **Generated artifacts regenerated**, not hand-edited, and they reproduce
      byte-identically.
- [ ] **Verifier pass run** (non-trivial changes), with its report posted as a
      comment on this PR — not left in gitignored scratch.
- [ ] **Future work filed as an issue**, with no milestone unless it is inside
      the v1.0 cut. Nothing deferred into doc prose.

## Verification

<!-- Paste the real evidence: the gate's exit code, the smoke result, the
     regeneration diff (which should be empty). "Should be fine" is not
     verification. -->

```
```
