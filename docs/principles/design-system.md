# design-system — Reach for `@ds` before hand-rolling a control or a colour

**Rule:** Check the component inventory before writing a raw `<button>`, `<input>`, `<select>` or `<dialog>`. Spend a token before writing a colour: `design-system/src/styles/tokens.css` mints colour, `ui/` only spends it through `var()`.

**Gate:** `scripts/gates/ds_components.py` for raw controls and `scripts/gates/ds_colours.py` for colour literals — two per-file ratchets, each with its budgets in a JSON file that is the single source the gate and the docs both read.

- `scripts/gates/ds_components.py` — raw controls, budgets in `scripts/ds-raw-controls.json`. Baseline: **zero**. Every control in `ui/src` comes from the design system, so the budget map is empty and the gate fails on any raw control at all.
- `scripts/gates/ds_colours.py` — colour literals, budgets in `scripts/ds-color-literals.json`. Baseline: 4 literals across 2 files, all of them runtime fallbacks for canvas and WebGPU surfaces that cannot resolve `var()`.

**Wiring:** `ui/` reads the design system through the `@ds` alias, declared in `ui/vite.config.ts` and `ui/tsconfig.json` and pointed at `design-system/src`. There is no build, publish or copy step between the two — editing a design-system component changes the app directly. Tokens follow the same rule: `ui/src/styles/tokens.css` is a single `@import` of the design-system token surface and nothing of its own, so a token added there reaches the app without being restated. The *reset* deliberately does not: `design-system/src/styles/base.css` is the playground's global, and the app imports neither it nor `layout.css` — see [`../architecture/ui.md`](../architecture/ui.md) §11.6, which keeps design-system components self-contained by making sure no global is available to lean on.

**Why:** `design-system/` is the single source of truth for tokens and components; `ui/` borrows from it. Hand-rolling duplicates behaviour that already exists and drifts from the tokens. The failure was not hypothetical — the design system once shipped a `CommandPalette` that nothing imported, beside a hand-rolled `OmniBar` that imported only `Icon`, and a `FileTreeRow` that nothing imported beside a hand-rolled explorer row. Nobody knew the primitives were there, which is why the inventory exists.

**Exceptions:** One surface is *deliberately* bespoke, and it is bespoke by construction rather than by backlog: the graph hover label has no element to anchor to — it tracks a node drawn at canvas coordinates, and `Tooltip`/`Popover` both anchor to a child. It is a positioned `div` spending only tokens, and becomes migratable only if the design system gains a primitive that anchors to a point.

The two exceptions this file used to name are both gone. The ranked multi-kind OmniBar palette now spends a `CommandPalette` grown rich enough to carry it (#35), and the inline-control tail (#34) is migrated. `scripts/ds-raw-controls.json` therefore has an empty budget map — the allowlist still exists so that re-introducing a raw control costs an explicit, justified entry.

Extending a component additively (defaulting to prior behaviour) is always preferred to forking it app-side.

**Detail:** [`../architecture/ui.md`](../architecture/ui.md) §11.6 for the locked rules; `scripts/ds-raw-controls.json` and `scripts/ds-color-literals.json` for the per-file budgets.
