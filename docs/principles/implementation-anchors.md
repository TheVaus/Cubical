# implementation-anchors — An implementation doc names the code it describes

**Rule:** Anchor every invariant in `implementation/**` to symbols that still exist.

**Gate:** `scripts/gates/symbol_anchors.py` — every symbol in an `**Anchors:**` line must be found in the tracked source, wherever that line is written. Only `implementation/**` is *required* to carry one; an architecture doc that names code opts in by writing the line, and [`../architecture/navigation.md`](../architecture/navigation.md) does.

**Why:** [`no-comments`](no-comments.md) moves rationale out of the source and into `implementation/`. That trade only pays off if the docs stay tied to the code — otherwise the rot merely moved somewhere with a nicer filename. A comment at least sits next to the thing it lies about; a doc in another directory can describe a deleted function indefinitely, and confidently.

**Convention:** one `**Anchors:**` line per invariant, symbols separated by ` · `:

```
**Anchors:** adopt_external_rename · commit_rename · path_tracked
```

Use symbol names — functions, types, constants — not line numbers, which drift on every edit above them.

That example is not hypothetical. Before this gate existed, `engine-ipc.md` described the rename path as `validate_forward + fs::rename + commit_rename` and `validate_adopted + commit_rename`. **Neither `validate_forward` nor `validate_adopted` has ever existed** — both functions validate inline, and `commit_rename` is the only extracted piece. The decomposition was written from the plan and never reconciled with what shipped. It survived a month of reading because nothing checked it.

**Known limit:** this catches *deleted* code, not *changed* code. A function that keeps its name and reverses its meaning passes the gate while the doc becomes false. Nothing automatic catches that; it is what a `verifier` pass and the "owning doc updated in the same commit" rule are for.

**Exceptions:** `docs/archive/**` is frozen, and describes code that was deliberately allowed to disappear.

**Detail:** [`../implementation/README.md`](../implementation/README.md).
