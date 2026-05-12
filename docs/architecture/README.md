# Cubical — Architecture

Locked decisions. These are the result of deliberate review. They can be changed, but only by an explicit architecture review — not a session-level call. If code disagrees with a doc here, the doc wins until explicitly updated.

| Domain | File | Covers |
|---|---|---|
| Philosophy + stack | `foundation.md` | Why Cubical exists, tech choices |
| Vault + file identity | `vault.md` | Storage layout, identity model, external edits, binary assets |
| Document model | `document-model.md` | Frontmatter, wiki-links, block refs, canonical AST, tags, Pending Rewrites |
| Concurrency + IPC | `concurrency.md` | Three-lane model, command design |
| UI + settings | `ui.md` | Layout, Live Preview, theming, settings |
| Future layers | `planned.md` | Sync (L7), Plugins (L6), Time Machine (L8), open questions |
| Out of scope | `constraints.md` | Explicit non-features (and why) |
