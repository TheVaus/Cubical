# derived-state-disposable — Derived state must be rebuildable from the markdown

**Rule:** Never make the vault's correctness depend on state you cannot regenerate from the `.md` files.

**Gate:** none.

**Why:** Plain `.md` is the absolute source of truth, and that is only true if everything else can be deleted and rebuilt. It is what makes the vault portable, the app crash-safe, and an index wipe a non-event. Any new durable state that cannot be re-derived is an architecture change, not an implementation detail.

**Exceptions:** Exactly one, and it is why the durable rename journal exists — the **pending-rewrites queue** lives in the index and is not re-derivable, so it is mirrored to `.cubical/renames.jsonl`. Deleting the index without replaying the journal strands referrer links. Separately, durable **user config** (`config.toml`, `themes/`) is not derived state at all and is not covered by this rule.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §1 · [`../architecture/vault.md`](../architecture/vault.md) §3 owns the durable/rebuildable split · [`../implementation/vault-core.md`](../implementation/vault-core.md) for the journal.
