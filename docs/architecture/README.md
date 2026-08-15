# Cubical — Architecture

Locked decisions. These are the result of deliberate review. They can be changed, but only by an explicit architecture review — not a session-level call. If code disagrees with a doc here, the doc wins until explicitly updated.

| Domain | File | Covers |
|---|---|---|
| Philosophy + stack | `foundation.md` | Why Cubical exists, tech choices |
| Vault + file identity | `vault.md` | Storage layout, identity model, external edits, binary assets |
| Document model | `document-model.md` | Frontmatter, wiki-links, block refs, canonical AST, tags, Pending Rewrites |
| Concurrency + IPC | `concurrency.md` | Three-lane model, command design |
| UI + settings | `ui.md` | Layout, Live Preview, theming, settings |
| Navigation | `navigation.md` | Entry points, tab semantics, history, how each surface dispatches |
| Layers | `layers.md` | Which layers closed, what each delivered, where its frozen spec is |
| Constraints from unbuilt layers | `planned.md` | Only what constrains work *today*; the designs themselves are GitHub issues |
| Distribution | `distribution.md` | Which platforms ship, what each promises, packaging formats |
| Out of scope | `constraints.md` | Explicit non-features (and why) |
