# design-system — Reach for `@ds` before hand-rolling a control

**Rule:** Check the component inventory before writing a raw `<button>`, `<input>`, `<select>` or `<dialog>`.

**Gate:** none yet — planned `ds-components`. Baseline: 13 raw `<button>`, 5 raw `<input>` in `ui/src`; `<select>` and `<dialog>` are already at 0.

**Why:** `design-system/` is the single source of truth for tokens and components; `ui/` borrows from it. Hand-rolling duplicates behaviour that already exists and drifts from the tokens. The failure is not hypothetical — the design system ships a `CommandPalette` that nothing imports, beside a hand-rolled `ui/src/omnibar/OmniBar.tsx` that imports only `Icon`. Nobody knew the primitive was there, which is why the inventory exists.

**Exceptions:** Surfaces that stayed deliberately bespoke because no design-system component fit. That set is enumerated in [`../architecture/ui.md`](../architecture/ui.md) §11.6 and is currently down to the ranked multi-kind OmniBar palette. Extending a component additively (defaulting to prior behaviour) is always preferred to forking it app-side.

**Detail:** [`../architecture/ui.md`](../architecture/ui.md) §11.6 for the locked rules and the bespoke list.
