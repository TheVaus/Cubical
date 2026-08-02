# composability — Most features are toggleable blocks; the substrate is not

**Rule:** Design a feature so it switches off cleanly, leaving the `.md` byte-identical.

**Gate:** none.

**Why:** The user decides which parts of Cubical are switched on. A toggle changes behaviour and derived state only — never the source of truth, never the vault's portability. Switching a feature off drops its derived state, which is rebuilt if it comes back on. The honest scope is **most** features, not all: the substrate (vault, canonical AST, index, IPC) is always-on bedrock, and blocks stack on top of it.

**Exceptions:** The substrate is never a toggle. And blocks form a **dependency graph**, not free stacking — a block cannot be active while one it depends on is off (backlinks need the link index; embeds need link resolution). Every toggle multiplies the interaction and test surface, so tested **default sets** matter more than raw togglability.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §1 (commitment 4).
