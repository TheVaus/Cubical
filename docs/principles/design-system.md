# design-system — Reach for `@ds` before hand-rolling a control or a colour

**Rule:** Check the component inventory before writing a raw `<button>`, `<input>`, `<select>` or `<dialog>`. Spend a token before writing a colour: `design-system/src/styles/tokens.css` mints colour, `ui/` only spends it through `var()`.

**Gate:** `scripts/gates/ds_components.py` for raw controls and `scripts/gates/ds_colours.py` for colour literals — two per-file ratchets, each with its budgets in a JSON file that is the single source the gate and the docs both read.

- `scripts/gates/ds_components.py` — raw controls, budgets in `scripts/ds-raw-controls.json`. Baseline: 15 raw controls across 8 non-test files in `ui/src`; `<select>`, `<dialog>` and `<textarea>` are already at 0.
- `scripts/gates/ds_colours.py` — colour literals, budgets in `scripts/ds-color-literals.json`. Baseline: 4 literals across 2 files, all of them runtime fallbacks for canvas and WebGPU surfaces that cannot resolve `var()`.

**Wiring:** `ui/` reads the design system through the `@ds` alias, declared in `ui/vite.config.ts` and `ui/tsconfig.json` and pointed at `design-system/src`. There is no build, publish or copy step between the two — editing a design-system component changes the app directly. Tokens follow the same rule: `ui/src/styles/tokens.css` is a single `@import` of the design-system token surface and nothing of its own, so a token added there reaches the app without being restated. The *reset* deliberately does not: `design-system/src/styles/base.css` is the playground's global, and the app imports neither it nor `layout.css` — see [`../architecture/ui.md`](../architecture/ui.md) §11.6, which keeps design-system components self-contained by making sure no global is available to lean on.

**Why:** `design-system/` is the single source of truth for tokens and components; `ui/` borrows from it. Hand-rolling duplicates behaviour that already exists and drifts from the tokens. The failure is not hypothetical — the design system ships a `CommandPalette` that nothing imports, beside a hand-rolled `ui/src/omnibar/OmniBar.tsx` that imports only `Icon`. Nobody knew the primitive was there, which is why the inventory exists.

**Exceptions:** Two surfaces are *deliberately* bespoke. The ranked multi-kind OmniBar palette needs a richer `CommandPalette` than the flat DS one (issue #35). The graph hover label has no element to anchor to — it tracks a node drawn at canvas coordinates, and `Tooltip`/`Popover` both anchor to a child. Every other raw control in `ui/src` is **deferred migration debt**, not an exception: issue #34's inline-control tail.

The distinction matters and the docs used to blur it. `../architecture/ui.md` §11.6 is prose naming the bespoke surfaces; it is **not** the allowlist and cannot be used as one, because 15 raw controls exist across 8 files. The machine-readable budgets live in `scripts/ds-raw-controls.json`, which the gate reads and §11.6 links to — one source, two readers.

Extending a component additively (defaulting to prior behaviour) is always preferred to forking it app-side.

**Detail:** [`../architecture/ui.md`](../architecture/ui.md) §11.6 for the locked rules; `scripts/ds-raw-controls.json` and `scripts/ds-color-literals.json` for the per-file budgets.
