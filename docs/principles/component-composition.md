# component-composition — `App.tsx` composes features; it does not own them

**Rule:** Put new frontend state in the feature that reads it, and keep every `ui/src` file under its size budget.

**Gate:** `scripts/gates/composition.py` — a per-file ratchet plus a shell rule, both configured in `scripts/component-budgets.json`. Baseline: `App.tsx` at 2555 lines and 38 signals/stores, down from 3274, with the `./api/ipc` import waived under issue #86 until the document session, vault boot and watcher listeners move out.

**Why:** `App.tsx` reached 3274 lines as one function — ~70 signals, ~1500 lines of JSX, a 190-line `onMount`. No agent can hold that in context, so every edit to it is guesswork, and nothing inside the closure is reachable from a test. The autosave, dirty and conflict logic that [`../implementation/frontend.md`](../implementation/frontend.md) calls the sharpest data-loss hazard in the app had no unit test, because it *could* not have one.

It grew that way because nothing said not to. `../architecture/ui.md` §11.6 answers "where does a Button come from" and is silent on "what belongs in App", so an agent reading it concludes the composition rules are satisfied — the `ds-components` gate is green, every control comes from `@ds` — and adds its feature's state to the same closure, because that is where every comparable thing already lives. Issue #85 records that decision being made deliberately rather than by accumulation.

**Two checks, because either alone is trivially satisfied.** A size cap is met by moving lines sideways, which is why `.ts` is in scope as well as `.tsx` — otherwise a component meets its cap by pushing logic into a helper beside it. And a size cap does not stop re-absorption on its own: a feature can be added in far fewer lines than a cap notices. It cannot be added without an IPC call, so the shell may not import `./api/ipc`. That is the check that actually holds the shape.

**Exceptions:** A file over the default cap is either `bespoke` — one cohesive thing, where a finer split would invent a boundary the behaviour does not have — or `debt` with an issue. `api/ipc.ts` is bespoke because it is one chokepoint by design and holds the only registry of setting keys. `editor/decorations.ts` is bespoke because splitting it by mark type would mean several Lezer walks instead of one, against the measured-performance bar. `ast/normalize.ts` is bespoke because it mirrors the Rust normalizer and must stay diffable against it. Debt is not an exception; it is a number that should be going down.

**Known limit:** this counts lines and declarations, not coupling. A file can sit inside every budget and still be a feature reaching into another feature's internals. Cross-feature import rules are deliberately not gated — there is no `index.ts` discipline in `ui/src` to build them on — so that stays a `verifier` concern.

**Detail:** [`../architecture/ui.md`](../architecture/ui.md) §11.7 for the locked decision; `scripts/component-budgets.json` for the per-file budgets and the shell rule.
