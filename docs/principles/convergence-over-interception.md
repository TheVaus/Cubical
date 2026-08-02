# convergence-over-interception — Converge on the filesystem; never try to intercept it

**Rule:** Assume any external process can change the vault at any time, and make the engine converge on the result.

**Gate:** none — real-watcher end-to-end tests do out-of-band `fs::rename` against a live engine and assert on-disk effects.

**Why:** Cubical cannot intercept an external write. An AI CLI's file write is an `open`/`write` syscall, and interposing would need FUSE or DYLD machinery that contradicts portability and the no-external-services rule. Attempting it would also be a lie — correctness would silently depend on interception any `python` script bypasses. So the engine converges instead. Where a raw filesystem operation destroys *semantics* the index cannot re-derive (a move that leaves every `[[wikilink]]` dangling), recover what you can and surface the rest. **Silent rot is the one unacceptable outcome.**

**Exceptions:** none. Where pairing is ambiguous, **refuse to pair** — a missed rename is recoverable, a wrong rewrite corrupts markdown. Residue goes to the Integrity panel for explicit per-candidate confirmation; there is deliberately no auto-fix path.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §2.2 · [`../implementation/vault-core.md`](../implementation/vault-core.md).
