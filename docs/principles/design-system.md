# design-system — Reach for `@ds` before hand-rolling a control

**Rule:** Check the component inventory before writing a raw `<button>`, `<input>`, `<select>` or `<dialog>`.

**Gate:** `scripts/gates/ds_components.py` — a per-file ratchet, budgets in `scripts/ds-raw-controls.json`. Baseline: 12 raw `<button>`, 5 raw `<input>` across 6 non-test files in `ui/src`; `<select>` and `<dialog>` are already at 0.

**Why:** `design-system/` is the single source of truth for tokens and components; `ui/` borrows from it. Hand-rolling duplicates behaviour that already exists and drifts from the tokens. The failure is not hypothetical — the design system ships a `CommandPalette` that nothing imports, beside a hand-rolled `ui/src/omnibar/OmniBar.tsx` that imports only `Icon`. Nobody knew the primitive was there, which is why the inventory exists.

**Exceptions:** Two surfaces are *deliberately* bespoke. The ranked multi-kind OmniBar palette needs a richer `CommandPalette` than the flat DS one (issue #35). The graph hover label has no element to anchor to — it tracks a node drawn at canvas coordinates, and `Tooltip`/`Popover` both anchor to a child. Every other raw control in `ui/src` is **deferred migration debt**, not an exception: issue #34's inline-control tail.

The distinction matters and the docs used to blur it. `../architecture/ui.md` §11.6 is prose naming the bespoke surfaces; it is **not** the allowlist and cannot be used as one, because 17 raw controls exist across 6 files. The machine-readable budgets live in `scripts/ds-raw-controls.json`, which the gate reads and §11.6 links to — one source, two readers.

Extending a component additively (defaulting to prior behaviour) is always preferred to forking it app-side.

**Detail:** [`../architecture/ui.md`](../architecture/ui.md) §11.6 for the locked rules; `scripts/ds-raw-controls.json` for the per-file budgets.
